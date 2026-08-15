// Expected backend contract for APP_CONFIG.UPLOAD_ENDPOINT:
//
//   POST {endpoint}
//   Headers: Authorization: Bearer <google id token>, Content-Type: application/json
//   Body:    { "filename": "...", "contentType": "...", "size": 12345 }
//   Response: { "uploadUrl": "https://...presigned-s3-put-url...", "bucket": "...", "key": "..." }
//
// The backend must verify the Google ID token before issuing the presigned URL.
// The page then PUTs the raw file bytes to `uploadUrl` (Content-Type must match
// what was sent above, since a presigned PUT usually signs over it).

let idToken = null;
let selectedFile = null;

const els = {
  fileInput: document.getElementById("file-input"),
  uploadBtn: document.getElementById("upload-btn"),
  progressWrap: document.getElementById("progress-wrap"),
  progressBar: document.getElementById("progress-bar"),
  progressLabel: document.getElementById("progress-label"),
  statusMessage: document.getElementById("status-message"),
  signedInRow: document.getElementById("signed-in-row"),
  signedInAs: document.getElementById("signed-in-as"),
  signOutBtn: document.getElementById("sign-out-btn"),
  signinButton: document.getElementById("google-signin-button"),
};

els.fileInput.addEventListener("change", () => {
  selectedFile = els.fileInput.files[0] || null;
});

els.uploadBtn.addEventListener("click", startUpload);
els.signOutBtn.addEventListener("click", signOut);

// Google Identity Services calls this automatically once the client library has loaded.
function onGoogleLibraryLoad() {
  google.accounts.id.initialize({
    client_id: window.APP_CONFIG.GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: false,
  });
  google.accounts.id.renderButton(els.signinButton, { theme: "outline", size: "large" });
}
window.onGoogleLibraryLoad = onGoogleLibraryLoad;

function handleCredentialResponse(response) {
  idToken = response.credential;

  const payload = decodeJwtPayload(idToken);
  els.signedInAs.textContent = payload ? `Signed in as ${payload.email}` : "Signed in";
  els.signinButton.hidden = true;
  els.signedInRow.hidden = false;
}

function signOut() {
  idToken = null;
  google.accounts.id.disableAutoSelect();
  els.signinButton.hidden = false;
  els.signedInRow.hidden = true;
}

function decodeJwtPayload(token) {
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64));
  } catch (err) {
    return null;
  }
}

async function startUpload() {
  if (!idToken) {
    setStatus("Sign in with Google first.", true);
    return;
  }
  if (!selectedFile) {
    setStatus("Choose a file first.", true);
    return;
  }

  setStatus("Requesting upload URL...");
  els.uploadBtn.disabled = true;

  try {
    const presignRes = await fetch(window.APP_CONFIG.UPLOAD_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filename: selectedFile.name,
        contentType: selectedFile.type || "application/octet-stream",
        size: selectedFile.size,
      }),
    });

    if (!presignRes.ok) {
      throw new Error(`Endpoint returned ${presignRes.status}`);
    }

    const { uploadUrl, bucket, key } = await presignRes.json();
    if (!uploadUrl) {
      throw new Error("Response did not include an uploadUrl");
    }

    await putFileWithProgress(uploadUrl, selectedFile);

    setStatus(`Uploaded to s3://${bucket}/${key}`);
  } catch (err) {
    setStatus(`Upload failed: ${err.message}`, true);
  } finally {
    els.progressWrap.hidden = true;
    els.uploadBtn.disabled = false;
  }
}

function putFileWithProgress(uploadUrl, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    els.progressWrap.hidden = false;

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        const pct = Math.round((event.loaded / event.total) * 100);
        els.progressBar.value = pct;
        els.progressLabel.textContent = `${pct}%`;
        setStatus(`Uploading... ${pct}%`);
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`S3 upload returned ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Network error during upload")));

    xhr.send(file);
  });
}

function setStatus(message, isError = false) {
  els.statusMessage.textContent = message;
  els.statusMessage.classList.toggle("error", isError);
}
