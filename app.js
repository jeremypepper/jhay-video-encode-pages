// Expected backend contract for APP_CONFIG.UPLOAD_ENDPOINT:
//
//   POST {endpoint}
//   Headers: Authorization: Bearer <google id token>, Content-Type: application/json
//   Body:    { "filename": "...", "contentType": "...", "size": 12345, "targetSizeMb": 50,
//              "resolutionCap": "1080"|"720"|"480", "normalizeAudio": true }
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
  uploadForm: document.getElementById("upload-form"),
  fileInput: document.getElementById("file-input"),
  uploadBtn: document.getElementById("upload-btn"),
  progressWrap: document.getElementById("progress-wrap"),
  progressBar: document.getElementById("progress-bar"),
  statusMessage: document.getElementById("status-message"),
  signedInRow: document.getElementById("signed-in-row"),
  signedInAs: document.getElementById("signed-in-as"),
  signOutBtn: document.getElementById("sign-out-btn"),
  signinButton: document.getElementById("google-signin-button"),
  downloadLink: document.getElementById("download-link"),
  fileSize: document.getElementById("file-size"),
  targetSizeInput: document.getElementById("target-size-input"),
  resolutionCapInput: document.getElementById("resolution-cap-input"),
  normalizeAudioInput: document.getElementById("normalize-audio-input"),
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

// type="submit" so pressing Enter in any field (e.g. the target-size input)
// also triggers upload -- preventDefault stops the browser's native form
// submission (which would otherwise navigate/reload the page) so our own
// JS-driven flow runs instead.
els.uploadForm.addEventListener("submit", (event) => {
  event.preventDefault();
  startUpload();
});
els.signOutBtn.addEventListener("click", signOut);

// Google Identity Services calls this automatically once the client library has loaded.
function onGoogleLibraryLoad() {
  google.accounts.id.initialize({
    client_id: window.APP_CONFIG.GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: true,
  });
  // The actual persistent, clickable sign-in button. auto_select + prompt()
  // below is a nice-to-have for returning users (silent re-auth via One
  // Tap), but it's transient and doesn't always fire -- without a real
  // rendered button, a genuinely logged-out user has nothing to click at all.
  google.accounts.id.renderButton(els.signinButton, { theme: "outline", size: "large" });
  google.accounts.id.prompt();
}
window.onGoogleLibraryLoad = onGoogleLibraryLoad;

function handleCredentialResponse(response) {
  idToken = response.credential;
  sessionStorage.setItem(ID_TOKEN_STORAGE_KEY, idToken);
  showSignedIn(decodeJwtPayload(idToken));
}

// Not called on load -- checked lazily from startUpload() instead, since the
// rendered button can visually look signed-in (it reflects the browser's
// Google session) well before/after our own idToken state actually is, and
// trying to keep the two in sync proactively on load was unreliable. Checking
// only at the moment of action sidesteps that entirely.
function restoreSessionIfValid() {
  if (idToken) return true;

  const stored = sessionStorage.getItem(ID_TOKEN_STORAGE_KEY);
  if (!stored) return false;

  const payload = decodeJwtPayload(stored);
  const isExpired = !payload || !payload.exp || payload.exp * 1000 <= Date.now();
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
        targetSizeMb: Number(els.targetSizeInput.value) || 50,
        resolutionCap: els.resolutionCapInput.value,
        normalizeAudio: els.normalizeAudioInput.checked,
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
  let convertingStartedAt = null;
  let convertingStartPercent = null;

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

      if (data.status === "converting") {
        const pct = data.progressPercent ?? 0;
        if (convertingStartedAt === null) {
          convertingStartedAt = Date.now();
          convertingStartPercent = pct;
        }
        data.elapsedSeconds = (Date.now() - convertingStartedAt) / 1000;
        data.etaSeconds = estimateRemainingSeconds(convertingStartedAt, convertingStartPercent, pct);
      }

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

// Linear extrapolation from however much progress happened since conversion
// started tracking (in this browser tab) to now, projected out to 100%.
// Returns null until there's been at least some measurable progress -- with
// zero progress made so far there's nothing to extrapolate a rate from.
function estimateRemainingSeconds(startedAt, startPercent, currentPercent) {
  const progressMade = currentPercent - startPercent;
  if (progressMade <= 0) return null;

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const remainingPercent = 100 - currentPercent;
  return Math.round((elapsedSeconds / progressMade) * remainingPercent);
}

function formatDuration(totalSeconds) {
  if (totalSeconds == null) return null;
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes === 0 ? `${remainingSeconds}s` : `${minutes}m ${remainingSeconds}s`;
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

      // Only seek during the actual encode (pass 2, or the single-pass CRF
      // fallback where encodePass is absent) -- pass 1 is just analysis, its
      // percent doesn't correspond to "how far through the video" the same
      // way. duration is NaN until the browser's finished loading the local
      // preview's metadata, so that has to be checked too.
      if (data.encodePass !== 1 && videoPlayer.duration && !isNaN(videoPlayer.duration)) {
        videoPlayer.currentTime = (pct / 100) * videoPlayer.duration;
      }

      // encodePass is only present for the two-pass (target-size) path --
      // absent means the single-pass CRF fallback, which has no "pass" concept.
      let label = "Converting";
      if (data.encodePass === 1) label = "Pass 1/2 (analyzing)";
      else if (data.encodePass === 2) label = "Pass 2/2 (encoding)";

      const elapsed = formatDuration(data.elapsedSeconds);
      const eta = formatDuration(data.etaSeconds);
      const parts = [];
      if (elapsed) parts.push(`${elapsed} elapsed`);
      if (eta) parts.push(`about ${eta} remaining`);

      setStatus(parts.length ? `${label}... ${pct}% (${parts.join(", ")})` : `${label}... ${pct}%`);
      break;
    }
    case "done": {
      els.progressWrap.hidden = true;
      const costSuffix = data.estimatedCostUsd != null ? ` (Estimated Jeremy cost: $${data.estimatedCostUsd.toFixed(4)})` : "";
      setStatus(`Done! Converted file: ${data.outputKey}${costSuffix}`);
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
    }
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


const videoPlayer = document.getElementById('videoPlayer');
function loadFileInVideo(file) {
  if (file) {
    // Create a temporary blob URL pointing to the local file
    const fileURL = URL.createObjectURL(file);

    videoPlayer.src = fileURL;
    videoPlayer.style.display = 'block';
  }
}
els.fileInput.addEventListener('change', function(event) {
  const file = event.target.files[0];
  loadFileInVideo(file);
});
// on load sometimes there is already a cached file
loadFileInVideo(els.fileInput.files[0])
