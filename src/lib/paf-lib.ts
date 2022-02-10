import UAParser from "ua-parser-js";
import {
  GetIdsPrefsResponse,
  IdsAndOptionalPreferences,
  IdsAndPreferences,
  PostIdsPrefsRequest,
  Preferences,
  RedirectGetIdsPrefsResponse
} from "paf-mvp-core-js/dist/model/generated-model";
import {
  Cookies,
  fromCookieValues,
  getPrebidDataCacheExpiration,
  UNKNOWN_TO_OPERATOR
} from "paf-mvp-core-js/dist/cookies";
import {NewPrefs} from "paf-mvp-core-js/dist/model/model";
import {jsonEndpoints, proxyEndpoints, proxyUriParams, redirectEndpoints} from "paf-mvp-core-js/dist/endpoints";
import {isBrowserKnownToSupport3PC} from "paf-mvp-core-js/dist/user-agent";
import {decodeBase64, QSParam} from "paf-mvp-core-js/dist/query-string";

const getPafDataFromQueryString = <T>(urlParams: URLSearchParams): T|undefined => {
  const data = urlParams.get(QSParam.paf);
  return data ? JSON.parse(decodeBase64(data)) as T : undefined
}

const logger = console;

const redirect = (url: string): void => {
  document.location = url;
}

// Remove any "paf data" param from the query string
// From https://stackoverflow.com/questions/1634748/how-can-i-delete-a-query-string-parameter-in-javascript/25214672#25214672
// TODO should be able to use a more standard way, but URL class is immutable :-(
const removeUrlParameter = (url: string, parameter: string) => {
  const urlParts = url.split('?');

  if (urlParts.length >= 2) {
    // Get first part, and remove from array
    const urlBase = urlParts.shift();

    // Join it back up
    const queryString = urlParts.join('?');

    const prefix = `${encodeURIComponent(parameter)}=`;
    const parts = queryString.split(/[&;]/g);

    // Reverse iteration as may be destructive
    for (let i = parts.length; i-- > 0;) {
      // Idiom for string.startsWith
      if (parts[i].lastIndexOf(prefix, 0) !== -1) {
        parts.splice(i, 1);
      }
    }

    url = urlBase + (parts.length > 0 ? (`?${parts.join('&')}`) : '');
  }

  return url;
};

const getCookieValue = (name: string): string => (
  document.cookie.match(`(^|;)\\s*${name}\\s*=\\s*([^;]+)`)?.pop() || ''
)

const setCookie = (name: string, value: string, expiration: Date) => {
  document.cookie = `${name}=${value};expires=${expiration.toUTCString()}`
}

// Update the URL shown in the address bar, without Prebid SSO data
const cleanUpUrL = () => history.pushState(null, "", removeUrlParameter(location.href, QSParam.paf));

const getProxyUrl = (proxyBase: string) => (endpoint: string): string => {
  return `${proxyBase}/prebid${endpoint}`
}

const saveCookieValueOrUnknown = <T>(cookieName: string, cookieValue: T | undefined): string => {
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

const processGetIdsAndPreferences = async (proxyBase: string): Promise<IdsAndOptionalPreferences | undefined> => {

  const getUrl = getProxyUrl(proxyBase)

  // 1. Any Prebid 1st party cookie?
  const rawIds = getCookieValue(Cookies.identifiers)
  const rawPreferences = getCookieValue(Cookies.preferences)

  if (rawIds && rawPreferences) {
    logger.info('Cookie found: YES')
    cleanUpUrL();

    return fromCookieValues(rawIds, rawPreferences)
  }

  logger.info('Cookie found: NO')

  const urlParams = new URLSearchParams(window.location.search);
  const uriData = getPafDataFromQueryString<RedirectGetIdsPrefsResponse>(urlParams);

  cleanUpUrL();

  // 2. Redirected from operator?
  if (uriData) {
    logger.info('Redirected from operator: YES')

    if (!uriData.response) {
      // FIXME do something smart in case of error
      throw uriData.error
    }

    // Consider that if we have been redirected, it means 3PC are not supported
    thirdPartyCookiesSupported = false;

    // Verify message
    const response = await fetch(getUrl(proxyEndpoints.verifyRead), {
      method: 'POST',
      body: JSON.stringify(uriData.response),
      credentials: 'include'
    })
    const verificationResult = await response.json() as GetIdsPrefsResponse

    if (!verificationResult) {
      throw 'Verification failed'
    }

    const operatorData = uriData.response

    // 3. Received data?
    const persistedIds = operatorData.body.identifiers?.filter(identifier => identifier?.persisted !== false);
    saveCookieValueOrUnknown(Cookies.identifiers, persistedIds.length === 0 ? undefined : persistedIds)
    saveCookieValueOrUnknown(Cookies.preferences, operatorData.body.preferences)

    return operatorData.body
  }

  logger.info('Redirected from operator: NO')

  // 4. Browser known to support 3PC?
  const userAgent = new UAParser(navigator.userAgent);

  if (isBrowserKnownToSupport3PC(userAgent.getBrowser())) {
    logger.info('Browser known to support 3PC: YES')

    logger.info('Attempt to read from JSON')
    const readResponse = await fetch(getUrl(jsonEndpoints.read), {credentials: 'include'})
    const operatorData = await readResponse.json() as GetIdsPrefsResponse

    const persistedIds = operatorData.body.identifiers?.filter(identifier => identifier?.persisted !== false);

    // 3. Received data?
    if (persistedIds) {
      logger.info('Operator returned id & prefs: YES')

      // If we got data, it means 3PC are supported
      thirdPartyCookiesSupported = true;

      // /!\ Note: we don't need to verify the message here as it is a REST call

      saveCookieValueOrUnknown(Cookies.identifiers, persistedIds)
      saveCookieValueOrUnknown(Cookies.preferences, operatorData.body.preferences)

      return operatorData.body
    }
    logger.info('Operator returned id & prefs: NO')

    logger.info('Verify 3PC on operator')
    // Note: need to include credentials to make sure cookies are sent
    const verifyResponse = await fetch(getUrl(jsonEndpoints.verify3PC), {credentials: 'include'})
    const testOk = await verifyResponse.json()

    // 4. 3d party cookie ok?
    if (testOk) {
      logger.info('3PC verification OK: YES')

      thirdPartyCookiesSupported = true;

      logger.info('Save "unknown"')
      setCookie(Cookies.identifiers, UNKNOWN_TO_OPERATOR, getPrebidDataCacheExpiration())
      setCookie(Cookies.preferences, UNKNOWN_TO_OPERATOR, getPrebidDataCacheExpiration())

      return {identifiers: operatorData.body.identifiers}
    }
    logger.info('3PC verification OK: NO')
    thirdPartyCookiesSupported = false;
    logger.info('Fallback to JS redirect')
  } else {
    logger.info('Browser known to support 3PC: NO')
    thirdPartyCookiesSupported = false;
    logger.info('JS redirect')
  }

  const redirectUrl = new URL(getUrl(redirectEndpoints.read))
  redirectUrl.searchParams.set(proxyUriParams.returnUrl, location.href)
  redirect(redirectUrl.toString());
};

const processWriteIdsAndPref = async (proxyBase: string, unsignedRequest: IdsAndPreferences): Promise<IdsAndOptionalPreferences | undefined> => {
  const getUrl = getProxyUrl(proxyBase)

  // First clean up local cookies
  removeCookie(Cookies.identifiers)
  removeCookie(Cookies.preferences)

  // FIXME this boolean will be up to date only if a read occurred just before. If not, would need to explicitly test
  if (thirdPartyCookiesSupported) {
    // 1) sign the request
    const signedResponse = await fetch(getUrl(proxyEndpoints.signWrite), {
      method: 'POST',
      body: JSON.stringify(unsignedRequest),
      credentials: 'include'
    })
    const signedData = await signedResponse.json() as PostIdsPrefsRequest

    // 2) send
    const response = await fetch(getUrl(jsonEndpoints.write), {
      method: 'POST',
      body: JSON.stringify(signedData),
      credentials: 'include'
    })
    const operatorData = await response.json() as GetIdsPrefsResponse

    const persistedIds = operatorData.body.identifiers.filter(identifier => identifier?.persisted !== false);

    saveCookieValueOrUnknown(Cookies.identifiers, persistedIds.length === 0 ? undefined : persistedIds)
    saveCookieValueOrUnknown(Cookies.preferences, operatorData.body.preferences);

    return operatorData.body

  }
  // Redirect. Signing of the request will happen on the backend proxy
  const redirectUrl = new URL(getUrl(redirectEndpoints.write))
  redirectUrl.searchParams.set(proxyUriParams.returnUrl, location.href)
  redirectUrl.searchParams.set(proxyUriParams.message, JSON.stringify(unsignedRequest))

  redirect(redirectUrl.toString());
}

/**
 * @param proxyBase ex: http://myproxy.com
 */
export const getIdsAndPreferences = async (proxyBase: string): Promise<IdsAndOptionalPreferences | undefined> => {
  const idsAndPreferences = await processGetIdsAndPreferences(proxyBase);

  logger.info('Finished', idsAndPreferences)

  return idsAndPreferences;
}

export const writeIdsAndPref = async (proxyBase: string, input: IdsAndPreferences): Promise<IdsAndOptionalPreferences | undefined> => {
  const idsAndPreferences = await processWriteIdsAndPref(proxyBase, input);

  logger.info('Finished', idsAndPreferences)

  return idsAndPreferences;
}

export const signPreferences = async (proxyBase: string, input: NewPrefs): Promise<Preferences> => {
  const getUrl = getProxyUrl(proxyBase)

  const signedResponse = await fetch(getUrl(proxyEndpoints.signPrefs), {
    method: 'POST',
    body: JSON.stringify(input),
    credentials: 'include'
  })
  return await signedResponse.json() as Preferences
}
