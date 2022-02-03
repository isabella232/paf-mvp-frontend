import UAParser from "ua-parser-js";
import {
    GetIdPrefsResponse,
    IdAndOptionalPreferences,
    IdAndPreferences,
    PostIdPrefsRequest,
    Preferences
} from "paf-mvp-core-js/dist/model/generated-model";
import {Cookies, fromCookieValues, getPrebidDataCacheExpiration, UNKNOWN_TO_OPERATOR} from "paf-mvp-core-js/dist/cookies";
import {NewPrefs} from "paf-mvp-core-js/dist/model/model";
import {jsonEndpoints, redirectEndpoints, signAndVerifyEndpoints, uriParams} from "paf-mvp-core-js/dist/endpoints";
import {isBrowserKnownToSupport3PC} from "paf-mvp-core-js/dist/user-agent";

const logger = console;

const redirect = (url: string): void => {
    document.location = url;
}

// Remove any "prebid data" param from the query string
// From https://stackoverflow.com/questions/1634748/how-can-i-delete-a-query-string-parameter-in-javascript/25214672#25214672
// TODO should be able to use a more standard way, but URL class is immutable :-(
const removeUrlParameter = (url: string, parameter: string) => {
    const urlParts = url.split('?');

    if (urlParts.length >= 2) {
        // Get first part, and remove from array
        const urlBase = urlParts.shift();

        // Join it back up
        const queryString = urlParts.join('?');

        const prefix = encodeURIComponent(parameter) + '=';
        const parts = queryString.split(/[&;]/g);

        // Reverse iteration as may be destructive
        for (let i = parts.length; i-- > 0;) {
            // Idiom for string.startsWith
            if (parts[i].lastIndexOf(prefix, 0) !== -1) {
                parts.splice(i, 1);
            }
        }

        url = urlBase + (parts.length > 0 ? ('?' + parts.join('&')) : '');
    }

    return url;
};

const getCookieValue = (name: string): string => (
    document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)')?.pop() || ''
)

const setCookie = (name: string, value: string, expiration: Date) => {
    document.cookie = `${name}=${value};expires=${expiration.toUTCString()}`
}

// Update the URL shown in the address bar, without Prebid SSO data
const cleanUpUrL = () => history.pushState(null, "", removeUrlParameter(location.href, uriParams.data));

const getProxyUrl = (proxyBase: string) => (endpoint: string): string => {
    return `${proxyBase}/prebid${endpoint}`
}

const redirectToProxyRead = (proxyBase: string) => (): void => {
    const redirectUrl = new URL(getProxyUrl(proxyBase)(redirectEndpoints.read))
    redirectUrl.searchParams.set(uriParams.returnUrl, location.href)
    redirect(redirectUrl.toString());
}

const saveCookieValueOrUnknown = <T>(cookieName: string, cookieValue: T | undefined) : string => {
    logger.info(`Operator returned value for ${cookieName}: ${cookieValue !== undefined ? 'YES' : 'NO'}`)

    const valueToStore = cookieValue ? JSON.stringify(cookieValue) : UNKNOWN_TO_OPERATOR

    logger.info(`Save ${cookieName} value: ${valueToStore}`)

    setCookie(cookieName, valueToStore, getPrebidDataCacheExpiration())

    return valueToStore;
}

const removeCookie = (cookieName: string) => {
    setCookie(cookieName, null, new Date(0))
}

let thirdPartyCookiesSupported: boolean | undefined;

const processGetIdAndPreferences = async (proxyBase: string): Promise<IdAndOptionalPreferences | undefined> => {

    const getUrl = getProxyUrl(proxyBase)
    const redirectToRead = redirectToProxyRead(proxyBase)

    // 1. Any Prebid 1st party cookie?
    const id = getCookieValue(Cookies.ID)
    const rawPreferences = getCookieValue(Cookies.PREFS)

    if (id && rawPreferences) {
        logger.info('Cookie found: YES')
        cleanUpUrL();

        return fromCookieValues(id, rawPreferences)
    }

    logger.info('Cookie found: NO')

    const urlParams = new URLSearchParams(window.location.search);
    const uriData = urlParams.get(uriParams.data);

    cleanUpUrL();

    // 2. Redirected from operator?
    if (uriData) {
        logger.info('Redirected from operator: YES')

        // Consider that if we have been redirected, it means 3PC are not supported
        thirdPartyCookiesSupported = false;

        // Verify message
        const response = await fetch(getUrl(signAndVerifyEndpoints.verifyRead), {
            method: 'POST',
            body: uriData,
            credentials: 'include'
        })
        const verificationResult = await response.json() as GetIdPrefsResponse

        if (!verificationResult) {
            throw 'Verification failed'
        }

        const operatorData = JSON.parse(uriData ?? '{}') as GetIdPrefsResponse

        // 3. Received data?
        const returnedId = operatorData.body.identifiers?.[0]
        const hasPersistedId = returnedId?.persisted === undefined || returnedId?.persisted
        saveCookieValueOrUnknown(Cookies.ID, hasPersistedId ? returnedId : undefined)
        saveCookieValueOrUnknown(Cookies.PREFS, operatorData.body.preferences)

        return operatorData.body
    }

    logger.info('Redirected from operator: NO')

    // 4. Browser known to support 3PC?
    const userAgent = new UAParser(navigator.userAgent);

    if (isBrowserKnownToSupport3PC(userAgent.getBrowser())) {
        logger.info('Browser known to support 3PC: YES')

        logger.info('Attempt to read from JSON')
        const response = await fetch(getUrl(jsonEndpoints.read), {credentials: 'include'})
        const operatorData = await response.json() as GetIdPrefsResponse

        const returnedId = operatorData.body.identifiers?.[0]
        const hasPersistedId = returnedId?.persisted === undefined || returnedId?.persisted

        // 3. Received data?
        if (hasPersistedId) {
            logger.info('Operator returned id & prefs: YES')

            // If we got data, it means 3PC are supported
            thirdPartyCookiesSupported = true;

            // /!\ Note: we don't need to verify the message here as it is a REST call

            saveCookieValueOrUnknown(Cookies.ID, hasPersistedId ? returnedId : undefined)
            saveCookieValueOrUnknown(Cookies.PREFS, operatorData.body.preferences)

            return operatorData.body
        } else {
            logger.info('Operator returned id & prefs: NO')

            logger.info('Verify 3PC on operator')
            // Note: need to include credentials to make sure cookies are sent
            const response = await fetch(getUrl(jsonEndpoints.verify3PC), {credentials: 'include'})
            const testOk = await response.json()

            // 4. 3d party cookie ok?
            if (testOk) {
                logger.info('3PC verification OK: YES')

                thirdPartyCookiesSupported = true;

                logger.info('Save "unknown"')
                setCookie(Cookies.ID, UNKNOWN_TO_OPERATOR, getPrebidDataCacheExpiration())
                setCookie(Cookies.PREFS, UNKNOWN_TO_OPERATOR, getPrebidDataCacheExpiration())

                return {identifiers: [returnedId]}
            } else {
                logger.info('3PC verification OK: NO')

                thirdPartyCookiesSupported = false;

                logger.info('Fallback to JS redirect')
                return redirectToRead() as undefined
            }

        }

    } else {
        logger.info('Browser known to support 3PC: NO')

        thirdPartyCookiesSupported = false;

        logger.info('JS redirect')
        return redirectToRead() as undefined
    }
};

const processWriteIdAndPref = async (proxyBase: string, unsignedRequest: IdAndPreferences): Promise<IdAndOptionalPreferences | undefined> => {
    const getUrl = getProxyUrl(proxyBase)

    // First clean up local cookies
    removeCookie(Cookies.ID)
    removeCookie(Cookies.PREFS)

    // FIXME this boolean will be up to date only if a read occurred just before. If not, would need to explicitly test
    if (thirdPartyCookiesSupported) {
        // 1) sign the request
        const signedResponse = await fetch(getUrl(signAndVerifyEndpoints.signWrite), {
            method: 'POST',
            body: JSON.stringify(unsignedRequest),
            credentials: 'include'
        })
        const signedData = await signedResponse.json() as PostIdPrefsRequest

        // 2) send
        const response = await fetch(getUrl(jsonEndpoints.write), {
            method: 'POST',
            body: JSON.stringify(signedData),
            credentials: 'include'
        })
        const operatorData = await response.json() as GetIdPrefsResponse

        const returnedId = operatorData.body.identifiers?.[0]
        const hasPersistedId = returnedId?.persisted === undefined || returnedId?.persisted

        saveCookieValueOrUnknown(Cookies.ID, hasPersistedId ? returnedId : undefined);
        saveCookieValueOrUnknown(Cookies.PREFS, operatorData.body.preferences);

        return operatorData.body

    } else {
        // Redirect. Signing of the request will happen on the backend proxy
        const redirectUrl = new URL(getUrl(redirectEndpoints.write))
        redirectUrl.searchParams.set(uriParams.returnUrl, location.href)
        redirectUrl.searchParams.set(uriParams.data, JSON.stringify(unsignedRequest))

        return redirect(redirectUrl.toString()) as undefined;
    }
}

/**
 * @param proxyBase ex: http://myproxy.com
 */
export const getIdAndPreferences = async (proxyBase: string): Promise<IdAndOptionalPreferences | undefined> => {
    const idAndPreferences = await processGetIdAndPreferences(proxyBase);

    logger.info('Finished', idAndPreferences)

    return idAndPreferences;
}

export const writeIdAndPref = async (proxyBase: string, input: IdAndPreferences): Promise<IdAndOptionalPreferences | undefined> => {
    const idAndPreferences = await processWriteIdAndPref(proxyBase, input);

    logger.info('Finished', idAndPreferences)

    return idAndPreferences;
}

export const signPreferences = async (proxyBase: string, input: NewPrefs): Promise<Preferences> => {
    const getUrl = getProxyUrl(proxyBase)

    const signedResponse = await fetch(getUrl(signAndVerifyEndpoints.signPrefs), {
        method: 'POST',
        body: JSON.stringify(input),
        credentials: 'include'
    })
    return await signedResponse.json() as Preferences
}
