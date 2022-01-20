# Prebid Addressability Framework (PAF) frontend library and widget

This app is a javascript library that provides API to authenticate user and get his consent for
personalized advertisement.
This app also contains widget that can be integrated into advertiser/publisher website.

## Widget integration

To integrate the widget into website, Website Owner should inject the app bundle:
```html
<script src="https://{{widget-domain}}/app.bundle.js"></script>
```
and add a tag with widget target attribute:
```html
<div prebid-sso-root></div>
```
Website Owners can provide additional information to the widget, such a brand logo, brand name etc.
```html
<!--NOT WORKING IN IE-->
<div prebid-sso-root>
  <script type="application/json">
      {
        "brandName": "The Publisher",
        "brandLogoUrl":"http://localhost:3000/images/default-customer-logo.png",
        "color": "green"
      }
  </script>
</div>
```
OR
```html
<!-- WORKS EVERYWHERE -->
<div
  prebid-sso-root
  data-prop-brand-name="The Publisher"
  data-prop-brand-logo-url="http://localhost:3000/images/default-customer-logo.png">
</div>
```

## Development

You can run `npm start` to create a bundle and start server. The bundle will be available on
http://localhost:3000/dist/app.bundle.js

You can open http://localhost:3000/ to see how it looks like in the sandbox.
To test app in "Real Environment", you can inject script (as described above) to any website.

There are also available scripts:
* `npm run lint` and `npm run lint:prettier` - to lint a code style.

## Deployment
Once deployed, the bundle will be available by the path: `https://{{domain}}/app.bundle.js`
