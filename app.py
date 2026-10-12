"""
Flask web application for ANPR System.
Provides login, image upload, video upload, and live webcam detection.
"""

from flask import (
    Flask, render_template, request, redirect,
    url_for, session, jsonify, send_from_directory,
)
from functools import wraps
from anpr_core import ANPREngine
import os
import base64
import cv2
import numpy as np

# ── App Setup ────────────────────────────────────────────────

app = Flask(__name__)
app.secret_key = "anpr-secret-key-change-in-production"
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB

engine = ANPREngine.get_instance()

# ── Simple User Store ────────────────────────────────────────

USERS = {
    "admin": "admin123",
}

# ── Auth Decorator ───────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user" not in session:
            if request.is_json or request.path.startswith("/api"):
                return jsonify({"error": "Unauthorized"}), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated

# ── Page Routes ──────────────────────────────────────────────

@app.route("/")
def index():
    if "user" in session:
        return redirect(url_for("dashboard"))
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        if username in USERS and USERS[username] == password:
            session["user"] = username
            return redirect(url_for("dashboard"))
        return render_template("login.html", error="Invalid username or password")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.pop("user", None)
    return redirect(url_for("login"))


@app.route("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html", user=session["user"])

# ── API Routes ───────────────────────────────────────────────

@app.route("/api/process-image", methods=["POST"])
@login_required
def api_process_image():
    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    file = request.files["image"]
    if file.filename == "":
        return jsonify({"error": "Empty filename"}), 400

    image_bytes = file.read()
    result = engine.process_image_bytes(image_bytes)

    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@app.route("/api/process-video", methods=["POST"])
@login_required
def api_process_video():
    if "video" not in request.files:
        return jsonify({"error": "No video file provided"}), 400

    file = request.files["video"]
    if file.filename == "":
        return jsonify({"error": "Empty filename"}), 400

    # Save temporarily
    temp_path = os.path.join(engine.base_dir, "temp_upload_video.mp4")
    file.save(temp_path)

    try:
        result = engine.process_video_file(temp_path, frame_skip=10)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@app.route("/api/process-frame", methods=["POST"])
@login_required
def api_process_frame():
    data = request.get_json(silent=True)
    if not data or "frame" not in data:
        return jsonify({"error": "No frame data"}), 400

    # Decode base64 data-URL
    frame_data = data["frame"]
    if "," in frame_data:
        frame_data = frame_data.split(",", 1)[1]

    try:
        frame_bytes = base64.b64decode(frame_data)
    except Exception:
        return jsonify({"error": "Invalid base64 data"}), 400

    nparr = np.frombuffer(frame_bytes, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if frame is None:
        return jsonify({"error": "Could not decode frame"}), 400

    result = engine.process_frame(frame, direct_save=False)
    return jsonify(result)


@app.route("/api/logs")
@login_required
def api_logs():
    logs = engine.get_logs()
    return jsonify(logs)


@app.route("/plates_images/<path:filename>")
@login_required
def serve_plate_image(filename):
    return send_from_directory(engine.image_dir, filename)

# ── Entry Point ──────────────────────────────────────────────

if __name__ == "__main__":
    print("🔄 Loading ANPR models — this may take a moment...")
    engine.load_models()
    print("🚀 Server starting at http://localhost:5000")
    app.run(debug=False, host="0.0.0.0", port=5000)
