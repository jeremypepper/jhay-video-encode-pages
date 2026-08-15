// Local, editable configuration for the upload page.
window.APP_CONFIG = {
  // Google Cloud Console -> APIs & Services -> Credentials -> OAuth client ID -> Web application.
  // Authorized JavaScript origin must match wherever this page is served from.
  GOOGLE_CLIENT_ID: "219257486318-j1utjglouasenlpgsejo369c941gkig0.apps.googleusercontent.com",

  // Presign Lambda, fronted by API Gateway.
  UPLOAD_ENDPOINT: "https://2wge3yb3u4.execute-api.us-west-2.amazonaws.com/presign",
};
