// Expected backend contract for APP_CONFIG.UPLOAD_ENDPOINT:
//
//   POST {endpoint}
//   Headers: Authorization: Bearer <google id token>, Content-Type: application/json
//   Body:    { "filename": "...", "contentType": "...", "size": 12345 }
//   Response: { "uploadUrl": "...presigned-s3-put-url...", "bucket": "...", "key": "...", "jobId": "..." }
//
// The backend must verify the Google ID token before issuing the presigned URL.
// The page then PUTs the raw file bytes to `uploadUrl` (Content-Type must match
// what was sent above, since a presigned PUT usually signs over it).
//
// Expected contract for APP_CONFIG.STATUS_ENDPOINT_BASE:
//
//   GET {STATUS_ENDPOINT_BASE}/{jobId}
//   Headers: Authorization: Bearer <google id token>
//   Response: { "status": "uploading"|"uploaded"|"converting"|"done"|"failed",
//               "progressPercent": 0-100, "outputBucket": "...", "outputKey": "...",
//               "errorMessage": "..." }

const ID_TOKEN_STORAGE_KEY = "videoUpload.idToken";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // safety cap so a stuck job doesn't poll forever
const MAX_CONSECUTIVE_POLL_ERRORS = 3; // give up sooner than the deadline if the endpoint's actually down

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
  downloadLink: document.getElementById("download-link"),
  fileSize: document.getElementById("file-size"),
};

function updateSelectedFile() {
  selectedFile = els.fileInput.files[0] || null;
  els.fileSize.textContent = selectedFile ? `${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB` : "";
}

// A refresh can leave the native file input showing a previously chosen file
// even though this script's state was just reset, so read whatever's already
// there instead of waiting for a "change" event that won't fire again.
updateSelectedFile();

els.fileInput.addEventListener("change", updateSelectedFile);

els.uploadBtn.addEventListener("click", startUpload);
els.signOutBtn.addEventListener("click", signOut);

// Google Identity Services calls this automatically once the client library has loaded.
function onGoogleLibraryLoad() {
  console.log("onGoogleLibraryLoad")
  google.accounts.id.initialize({
    client_id: window.APP_CONFIG.GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: true,
  });
  // Trigger the prompt (this handles Google One Tap and auto-selection)
  google.accounts.id.prompt((notification) => {
    if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
      console.log("Auto-select skipped. User may need to click a standard sign-in button.");
    }
  });
  //google.accounts.id.renderButton(els.signinButton, { theme: "outline", size: "large" });
  console.log("onGoogleLibraryLoad done")
}
window.onGoogleLibraryLoad = onGoogleLibraryLoad;

function handleCredentialResponse(response) {
  idToken = response.credential;
  console.log("handleCredentialResponse", idToken, response)
  sessionStorage.setItem(ID_TOKEN_STORAGE_KEY, idToken);
  showSignedIn(decodeJwtPayload(idToken));
}

// Not called on load -- checked lazily from startUpload() instead, since the
// rendered button can visually look signed-in (it reflects the browser's
// Google session) well before/after our own idToken state actually is, and
// trying to keep the two in sync proactively on load was unreliable. Checking
// only at the moment of action sidesteps that entirely.
function restoreSessionIfValid() {
  console.log("restoreSessionIfValid")
  if (idToken) return true;

  const stored = sessionStorage.getItem(ID_TOKEN_STORAGE_KEY);
  if (!stored) return false;

  const payload = decodeJwtPayload(stored);
  const isExpired = !payload || !payload.exp || payload.exp * 1000 <= Date.now();
  console.log("isexpired", isExpired)
  if (isExpired) {
    sessionStorage.removeItem(ID_TOKEN_STORAGE_KEY);
    return false;
  }

  idToken = stored;
  showSignedIn(payload);
  return true;
}

function showSignedIn(payload) {
  els.signedInAs.textContent = payload ? `Signed in as ${payload.email}` : "Signed in";
  els.signinButton.hidden = true;
  els.signedInRow.hidden = false;
}

function signOut() {
  idToken = null;
  sessionStorage.removeItem(ID_TOKEN_STORAGE_KEY);
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
  if (!restoreSessionIfValid()) {
    setStatus("Sign in with Google first.", true);
    return;
  }
  if (!selectedFile) {
    setStatus("Choose a file first.", true);
    return;
  }

  setStatus("Requesting upload URL...");
  els.uploadBtn.disabled = true;
  els.downloadLink.hidden = true;

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

    const { uploadUrl, bucket, key, jobId } = await presignRes.json();
    if (!uploadUrl) {
      throw new Error("Response did not include an uploadUrl");
    }

    await putFileWithProgress(uploadUrl, selectedFile);

    if (jobId) {
      // Progress bar stays live through this -- pollJobStatus manages its
      // visibility itself as the job moves through uploaded/converting/done.
      await pollJobStatus(jobId);
    } else {
      setStatus(`Uploaded to s3://${bucket}/${key}`);
      els.progressWrap.hidden = true;
    }
  } catch (err) {
    setStatus(`Upload failed: ${err.message}`, true);
    els.progressWrap.hidden = true;
  } finally {
    els.uploadBtn.disabled = false;
  }
}

function pollJobStatus(jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  let consecutiveErrors = 0;

  return new Promise((resolve) => {
    const poll = async () => {
      let data;
      try {
        const res = await fetch(`${window.APP_CONFIG.STATUS_ENDPOINT_BASE}/${jobId}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) {
          throw new Error(`Status endpoint returned ${res.status}`);
        }
        data = await res.json();
      } catch (err) {
        consecutiveErrors++;
        console.error(`Status poll failed (${consecutiveErrors}/${MAX_CONSECUTIVE_POLL_ERRORS})`, err);

        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          setStatus("Lost track of conversion progress after repeated errors -- check back later.", true);
          els.progressWrap.hidden = true;
          resolve();
          return;
        }

        // A single failed poll is likely transient -- retry on the next
        // tick. Repeated failures in a row (handled above) mean the
        // endpoint itself is probably down, not a one-off blip.
        return scheduleNextPollOrGiveUp();
      }

      consecutiveErrors = 0;
      applyJobStatus(data);

      if (data.status === "done" || data.status === "failed") {
        resolve();
        return;
      }

      scheduleNextPollOrGiveUp();
    };

    function scheduleNextPollOrGiveUp() {
      if (Date.now() < deadline) {
        setTimeout(poll, POLL_INTERVAL_MS);
      } else {
        setStatus("Still processing -- check back later.", true);
        els.progressWrap.hidden = true;
        resolve();
      }
    }

    poll();
  });
}

function applyJobStatus(data) {
  switch (data.status) {
    case "uploading":
      els.progressWrap.hidden = true;
      setStatus("Waiting for upload to be confirmed...");
      break;
    case "uploaded":
      els.progressWrap.hidden = true;
      setStatus("Upload confirmed, starting conversion...");
      break;
    case "converting": {
      const pct = data.progressPercent ?? 0;
      els.progressWrap.hidden = false;
      els.progressBar.value = pct;
      els.progressLabel.textContent = `${pct}%`;
      setStatus(`Converting... ${pct}%`);
      break;
    }
    case "done":
      els.progressWrap.hidden = true;
      setStatus(`Done! Converted file: s3://${data.outputBucket}/${data.outputKey}`);
      if (data.downloadUrl) {
        els.downloadLink.href = data.downloadUrl;
        els.downloadLink.hidden = false;
        // The presigned URL includes a Content-Disposition: attachment header
        // (set server-side), which is what actually makes a cross-origin
        // click trigger a save-as download instead of just navigating to it --
        // the HTML `download` attribute alone is ignored across origins.
        els.downloadLink.click();
      }
      break;
    case "failed":
      els.progressWrap.hidden = true;
      setStatus(`Conversion failed: ${data.errorMessage || "unknown error"}`, true);
      break;
    default:
      console.warn("Unknown job status", data.status);
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
        console.error("S3 PUT failed", xhr.status, xhr.statusText, xhr.responseText);
        reject(new Error(`S3 upload returned ${xhr.status}`));
      }
    });

    // "error"/"abort" fire for connection-level failures with no HTTP response at
    // all (dropped connection, expired presigned URL rejected before a response
    // body is readable cross-origin, etc.) -- these are the ones that show up in
    // the console as a generic, misleading CORS failure rather than a real status
    // code, so check the Network tab's request count/timing for this URL if it
    // keeps happening.
    xhr.addEventListener("error", () => reject(new Error("Network error during upload (see console/Network tab)")));
    xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));

    xhr.send(file);
  });
}

function setStatus(message, isError = false) {
  els.statusMessage.textContent = message;
  els.statusMessage.classList.toggle("error", isError);
}
