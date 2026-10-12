/**
 * ANPR System — Dashboard Frontend
 * Handles: tab switching, image upload, video upload,
 *          live webcam, results display, detection history.
 */

// ── Tiny helpers ──────────────────────────────────────────────
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

// ── Toast notifications ───────────────────────────────────────
function showToast(message, type = 'success') {
    const existing = $('.toast');
    if (existing) {
        existing.style.animation = 'toast-out 0.25s ease-in forwards';
        setTimeout(() => existing.remove(), 250);
    }

    const icons = {
        success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
        error:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        info:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    };

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.innerHTML = `${icons[type] || ''}<span>${message}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toast-out 0.3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3600);
}

// ── Button loading state ──────────────────────────────────────
function setLoading(btn, loading, text) {
    const textEl   = btn.querySelector('.btn__text');
    const loader   = btn.querySelector('.btn__loader');
    const iconEl   = btn.querySelector('svg:not(.btn__loader svg)');

    btn.disabled = loading;
    if (textEl) textEl.textContent = text;
    if (loader) loader.style.display = loading ? 'inline-block' : 'none';
    if (iconEl) iconEl.style.opacity = loading ? '0.4' : '1';
}

// ================================================================
//  TAB SWITCHING
// ================================================================

const tabs   = $$('.mode-tab');
const panels = $$('.mode-panel');

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const mode = tab.dataset.mode;

        tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        panels.forEach(p => p.classList.remove('active'));

        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        $(`#panel-${mode}`).classList.add('active');

        // Stop webcam when navigating away
        if (mode !== 'webcam' && webcamStream) stopWebcam();
    });
});

// ================================================================
//  IMAGE MODE
// ================================================================

const imageDropzone  = $('#image-dropzone');
const imageInput     = $('#image-input');
const imagePreview   = $('#image-preview');
const imagePreviewImg = $('#image-preview-img');
const imageFilename  = $('#image-filename');

let selectedImageFile = null;

// Open file dialog
imageDropzone.addEventListener('click', () => imageInput.click());

// Drag & drop
imageDropzone.addEventListener('dragover', e => { e.preventDefault(); imageDropzone.classList.add('dragover'); });
imageDropzone.addEventListener('dragleave', () => imageDropzone.classList.remove('dragover'));
imageDropzone.addEventListener('drop', e => {
    e.preventDefault();
    imageDropzone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) handleImageFile(f);
});

imageInput.addEventListener('change', () => {
    if (imageInput.files.length) handleImageFile(imageInput.files[0]);
});

function handleImageFile(file) {
    if (!file.type.startsWith('image/')) {
        showToast('Please select a valid image file (JPG, PNG, WEBP…)', 'error');
        return;
    }
    selectedImageFile = file;
    imageFilename.textContent = file.name;

    const reader = new FileReader();
    reader.onload = e => {
        imagePreviewImg.src = e.target.result;
        imagePreview.style.display  = 'block';
        imageDropzone.style.display = 'none';
    };
    reader.readAsDataURL(file);
}

$('#image-clear').addEventListener('click', () => {
    selectedImageFile = null;
    imagePreview.style.display  = 'none';
    imageDropzone.style.display = 'flex';
    imageInput.value = '';
});

$('#process-image-btn').addEventListener('click', async () => {
    if (!selectedImageFile) return;

    const btn = $('#process-image-btn');
    setLoading(btn, true, 'Detecting…');

    const formData = new FormData();
    formData.append('image', selectedImageFile);

    try {
        const res  = await fetch('/api/process-image', { method: 'POST', body: formData });
        const data = await res.json();

        if (!res.ok || data.error) {
            showToast(data.error || 'Server error processing image', 'error');
        } else {
            showResults(data, 'image');
            const cnt = data.plates?.length ?? 0;
            showToast(cnt > 0
                ? `${cnt} plate${cnt !== 1 ? 's' : ''} detected!`
                : 'No plates found in this image', cnt > 0 ? 'success' : 'info');
            loadHistory();
        }
    } catch (err) {
        showToast('Network error — is the Flask server running?', 'error');
        console.error(err);
    } finally {
        setLoading(btn, false, 'Detect Plates');
    }
});

// ================================================================
//  VIDEO MODE
// ================================================================

const videoDropzone  = $('#video-dropzone');
const videoInput     = $('#video-input');
const videoPreview   = $('#video-preview');
const videoPreviewEl = $('#video-preview-el');
const videoFilename  = $('#video-filename');
const videoProgressWrap = $('#video-progress-wrap');
const videoProgressFill = $('#video-progress-fill');
const videoProgressLabel = $('#video-progress-label');

let selectedVideoFile = null;
let progressTimer     = null;

// Open file dialog
videoDropzone.addEventListener('click', () => videoInput.click());

videoDropzone.addEventListener('dragover', e => { e.preventDefault(); videoDropzone.classList.add('dragover'); });
videoDropzone.addEventListener('dragleave', () => videoDropzone.classList.remove('dragover'));
videoDropzone.addEventListener('drop', e => {
    e.preventDefault();
    videoDropzone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) handleVideoFile(f);
});

videoInput.addEventListener('change', () => {
    if (videoInput.files.length) handleVideoFile(videoInput.files[0]);
});

function handleVideoFile(file) {
    if (!file.type.startsWith('video/')) {
        showToast('Please select a valid video file (MP4, AVI, MOV…)', 'error');
        return;
    }
    selectedVideoFile = file;
    videoFilename.textContent = file.name;

    const url = URL.createObjectURL(file);
    videoPreviewEl.src = url;
    videoPreview.style.display  = 'block';
    videoDropzone.style.display = 'none';
    videoProgressWrap.style.display = 'none';
}

$('#video-clear').addEventListener('click', () => {
    selectedVideoFile = null;
    videoPreview.style.display  = 'none';
    videoDropzone.style.display = 'flex';
    videoInput.value = '';
    videoPreviewEl.src = '';
    clearProgressTimer();
    videoProgressWrap.style.display = 'none';
});

function startFakeProgress() {
    // Animate progress bar 0→90% while waiting for server
    videoProgressWrap.style.display = 'block';
    videoProgressFill.style.width   = '0%';
    videoProgressLabel.textContent  = 'Uploading & processing…';

    let pct = 0;
    progressTimer = setInterval(() => {
        if (pct < 90) {
            pct += Math.random() * 3;
            videoProgressFill.style.width = Math.min(pct, 90) + '%';
        }
    }, 200);
}

function finishProgress(success) {
    clearProgressTimer();
    videoProgressFill.style.width = '100%';
    videoProgressLabel.textContent = success ? 'Done!' : 'Failed.';
    setTimeout(() => { videoProgressWrap.style.display = 'none'; }, 1500);
}

function clearProgressTimer() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

$('#process-video-btn').addEventListener('click', async () => {
    if (!selectedVideoFile) return;

    const btn = $('#process-video-btn');
    setLoading(btn, true, 'Processing…');
    startFakeProgress();

    const formData = new FormData();
    formData.append('video', selectedVideoFile);

    try {
        const res  = await fetch('/api/process-video', { method: 'POST', body: formData });
        const data = await res.json();

        if (!res.ok || data.error) {
            finishProgress(false);
            showToast(data.error || 'Server error processing video', 'error');
        } else {
            finishProgress(true);
            showResults(data, 'video');
            const cnt = data.plates?.length ?? 0;
            const frm = data.frames_processed ?? 0;
            showToast(cnt > 0
                ? `${cnt} unique plate${cnt !== 1 ? 's' : ''} found across ${frm} frames`
                : 'No plates detected in video', cnt > 0 ? 'success' : 'info');
            loadHistory();
        }
    } catch (err) {
        finishProgress(false);
        showToast('Network error — is the Flask server running?', 'error');
        console.error(err);
    } finally {
        setLoading(btn, false, 'Process Video');
    }
});

// ================================================================
//  WEBCAM MODE
// ================================================================

let webcamStream     = null;
let webcamInterval   = null;
let isProcessing     = false;
let overlayAnimId    = null;   // requestAnimationFrame id for live drawing
let lastBoxes        = [];     // latest bounding boxes from server
let serverFps        = 0;
let serverFrameCount = 0;
let fpsTimer         = null;

const webcamVideo       = $('#webcam-video');
const webcamCanvas      = $('#webcam-canvas');       // capture canvas (hidden)
const webcamPlaceholder = $('#webcam-placeholder');
const webcamStatus      = $('#webcam-status');
const webcamDetections  = $('#webcam-detections');
const webcamPlatesList  = $('#webcam-plates-list');
const webcamArea        = $('#webcam-area');
const webcamLiveBadge   = $('#webcam-live-badge');
const webcamFps         = $('#webcam-fps');
const liveDetectedPlates = new Map();

// Create overlay canvas that sits on top of the video element
let overlayCanvas = null;
function ensureOverlay() {
    if (overlayCanvas) return;
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.style.cssText = `
        position:absolute; inset:0; width:100%; height:100%;
        border-radius:0; pointer-events:none; z-index:4;
    `;
    webcamArea.appendChild(overlayCanvas);
}

$('#start-webcam-btn').addEventListener('click', startWebcam);
$('#stop-webcam-btn').addEventListener('click', stopWebcam);
$('#clear-live-btn').addEventListener('click', () => {
    webcamPlatesList.innerHTML = '';
    liveDetectedPlates.clear();
});

async function startWebcam() {
    try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } }
        });

        webcamVideo.srcObject = webcamStream;
        webcamVideo.style.display       = 'block';
        webcamPlaceholder.style.display = 'none';

        webcamArea.classList.add('scanning');
        webcamLiveBadge.style.display = 'flex';
        webcamFps.style.display       = 'block';

        $('#start-webcam-btn').style.display = 'none';
        $('#stop-webcam-btn').style.display  = 'inline-flex';
        webcamStatus.innerHTML = '<span class="live-indicator"></span>&nbsp;Live detection active';
        webcamDetections.style.display = 'block';
        $('#stat-live').style.display  = 'flex';

        // Overlay canvas for bounding boxes
        ensureOverlay();
        drawOverlayLoop();

        // Send frames to server for inference every 1.5s (non-blocking)
        webcamInterval = setInterval(captureAndSend, 1500);

        // Server-side FPS meter
        fpsTimer = setInterval(() => {
            serverFps = +(serverFrameCount / 3).toFixed(1);
            webcamFps.textContent = `${serverFps} inference/s`;
            serverFrameCount = 0;
        }, 3000);

    } catch (err) {
        showToast('Could not access webcam — check browser permissions.', 'error');
        console.error('Webcam error:', err);
    }
}

function stopWebcam() {
    clearInterval(webcamInterval);
    clearInterval(fpsTimer);
    cancelAnimationFrame(overlayAnimId);
    webcamInterval = overlayAnimId = fpsTimer = null;
    lastBoxes = [];

    if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }

    // Clear overlay
    if (overlayCanvas) {
        overlayCanvas.getContext('2d').clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }

    webcamVideo.style.display       = 'none';
    webcamPlaceholder.style.display = 'flex';
    webcamArea.classList.remove('scanning');
    webcamLiveBadge.style.display   = 'none';
    webcamFps.style.display         = 'none';

    $('#start-webcam-btn').style.display = 'inline-flex';
    $('#stop-webcam-btn').style.display  = 'none';
    webcamStatus.innerHTML  = '';
    webcamDetections.style.display = 'none';
    $('#stat-live').style.display  = 'none';
    isProcessing = false;
}

/** Continuously draw bounding boxes on overlay canvas at 30fps
 *  without waiting for server — the video stays perfectly smooth. */
function drawOverlayLoop() {
    overlayAnimId = requestAnimationFrame(drawOverlayLoop);

    if (!overlayCanvas || !webcamVideo.videoWidth) return;

    overlayCanvas.width  = webcamVideo.videoWidth;
    overlayCanvas.height = webcamVideo.videoHeight;

    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    // Scale factors (video element may be displayed smaller than native size)
    const scaleX = overlayCanvas.width  / (overlayCanvas.offsetWidth  || overlayCanvas.width);
    const scaleY = overlayCanvas.height / (overlayCanvas.offsetHeight || overlayCanvas.height);

    lastBoxes.forEach(box => {
        const [x1, y1, x2, y2] = box.bbox;
        const label = box.cleaned_text || box.raw_text || '';
        const color = box.cleaned_text ? '#6366f1' : '#ef4444';

        ctx.strokeStyle = color;
        ctx.lineWidth   = 3;
        ctx.shadowColor = color;
        ctx.shadowBlur  = 8;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

        if (label) {
            const fontSize = Math.max(14, Math.round(overlayCanvas.height * 0.022));
            ctx.font      = `bold ${fontSize}px "JetBrains Mono", monospace`;
            const tw      = ctx.measureText(label).width;
            const th      = fontSize + 8;

            ctx.fillStyle  = color;
            ctx.shadowBlur = 0;
            ctx.fillRect(x1, y1 - th, tw + 14, th);

            ctx.fillStyle = '#fff';
            ctx.fillText(label, x1 + 7, y1 - 6);
        }
    });
}

/** Send a captured frame to the server for YOLO + OCR inference */
async function captureAndSend() {
    if (isProcessing || !webcamStream) return;
    isProcessing = true;

    try {
        const { videoWidth: w, videoHeight: h } = webcamVideo;
        if (!w || !h) return;

        // Draw current frame to hidden capture canvas
        webcamCanvas.width  = w;
        webcamCanvas.height = h;
        webcamCanvas.getContext('2d').drawImage(webcamVideo, 0, 0);

        // Downscale for faster upload (server infers on smaller image)
        const sendCanvas = document.createElement('canvas');
        const scale = Math.min(1, 640 / Math.max(w, h));
        sendCanvas.width  = Math.round(w * scale);
        sendCanvas.height = Math.round(h * scale);
        sendCanvas.getContext('2d').drawImage(webcamCanvas, 0, 0, sendCanvas.width, sendCanvas.height);
        const dataUrl = sendCanvas.toDataURL('image/jpeg', 0.70);

        const res  = await fetch('/api/process-frame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frame: dataUrl }),
        });
        const data = await res.json();
        if (!res.ok) return;

        // Update bounding boxes for overlay — scale back to full resolution
        if (data.plates) {
            lastBoxes = data.plates.map(p => ({
                ...p,
                bbox: p.bbox.map((v, i) => Math.round(v / scale)),
            }));
            serverFrameCount++;
        }

        // Add newly found plates to live list
        data.plates?.forEach(p => {
            const key = p.cleaned_text || null;
            if (!key || liveDetectedPlates.has(key)) return;
            const card = createPlateCard(p);
            webcamPlatesList.prepend(card);
            liveDetectedPlates.set(key, card);
            if (p.saved) { loadHistory(); updateTotalStat(); }
        });

    } catch (err) {
        console.warn('Frame send error:', err);
    } finally {
        isProcessing = false;
    }
}

// ================================================================
//  RESULTS DISPLAY
// ================================================================

function showResults(data, mode) {
    const section = $('#results-section');
    section.style.display = 'block';

    setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);

    // Annotated frame
    const frameEl = $('#result-annotated-img');
    if (data.annotated_frame) {
        frameEl.src           = 'data:image/jpeg;base64,' + data.annotated_frame;
        frameEl.style.display = 'block';
    } else {
        frameEl.style.display = 'none';
    }

    // Plate cards
    const container = $('#result-plates-container');
    container.innerHTML = '';

    const plates = data.plates ?? [];
    const resultsCount = $('#results-count');

    if (plates.length > 0) {
        resultsCount.textContent = `${plates.length} plate${plates.length !== 1 ? 's' : ''} detected`;
        plates.forEach(p => container.appendChild(createPlateCard(p)));
    } else {
        resultsCount.textContent = '';
        container.innerHTML = '<p class="empty-state">No plates detected in this input</p>';
    }
}

function createPlateCard(plate) {
    const card = document.createElement('div');
    const isReadable = !!plate.cleaned_text;
    card.className = `plate-card${plate.saved ? ' plate-card--saved' : ''}`;

    card.innerHTML = `
        <img src="data:image/jpeg;base64,${plate.plate_image}" alt="Cropped number plate" loading="lazy">
        <div class="plate-info">
            <span class="plate-text ${isReadable ? '' : 'unreadable'}">
                ${isReadable ? plate.cleaned_text : 'Unreadable'}
            </span>
            <span class="plate-conf">Confidence: ${(plate.confidence * 100).toFixed(1)}%</span>
            ${plate.saved ? '<span class="plate-saved">Saved to log</span>' : ''}
        </div>
    `;

    return card;
}

$('#clear-results-btn').addEventListener('click', () => {
    $('#results-section').style.display = 'none';
});

// ================================================================
//  DETECTION HISTORY
// ================================================================

async function loadHistory() {
    try {
        const res  = await fetch('/api/logs');
        const logs = await res.json();
        const tbody       = $('#history-body');
        const historyCount = $('#history-count');

        if (!logs || logs.length === 0) {
            tbody.innerHTML    = '<tr><td colspan="4" class="empty-state">No detections recorded yet</td></tr>';
            historyCount.textContent = '';
            updateTotalStat(0);
            return;
        }

        const sorted = [...logs].reverse();
        historyCount.textContent = `${sorted.length} record${sorted.length !== 1 ? 's' : ''}`;
        updateTotalStat(sorted.length);

        tbody.innerHTML = sorted.map((log, i) => `
            <tr>
                <td class="row-num">${sorted.length - i}</td>
                <td><span class="plate-badge">${escapeHtml(log.plate)}</span></td>
                <td>${escapeHtml(log.date)}</td>
                <td>${escapeHtml(log.time.replace(/-/g, ':'))}</td>
            </tr>
        `).join('');

    } catch (err) {
        console.error('Error loading history:', err);
    }
}

function updateTotalStat(n) {
    const el = $('#stat-total-num');
    if (el) el.textContent = n ?? el.textContent;
}

$('#refresh-history-btn').addEventListener('click', () => {
    loadHistory();
    showToast('History refreshed', 'info');
});

// ── Initial load
loadHistory();

// ================================================================
//  UTILITIES
// ================================================================

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
