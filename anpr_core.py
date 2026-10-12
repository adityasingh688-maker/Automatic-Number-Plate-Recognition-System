"""
ANPR Core Engine — wraps YOLO + TrOCR detection/OCR logic
for use by the Flask web application.
"""

from ultralytics import YOLO
import cv2
import re
import numpy as np
import base64
from datetime import datetime
import os
from transformers import TrOCRProcessor, VisionEncoderDecoderModel
from PIL import Image
from openpyxl import Workbook, load_workbook
import threading


class ANPREngine:
    """Singleton ANPR engine that loads models once and provides
    detection + OCR methods for image, video, and webcam frames."""

    _instance = None
    _lock = threading.Lock()

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def __init__(self):
        self.base_dir = os.path.dirname(os.path.abspath(__file__))
        self.model = None
        self.processor = None
        self.ocr_model = None
        self.loaded = False

        self.excel_file = os.path.join(self.base_dir, "plates.xlsx")
        self.image_dir = os.path.join(self.base_dir, "plates_images")
        self.plate_memory = {}
        self.saved_plates = set()

        os.makedirs(self.image_dir, exist_ok=True)
        self._init_excel()

    # ── Initialization ───────────────────────────────────────

    def _init_excel(self):
        if not os.path.exists(self.excel_file):
            wb = Workbook()
            ws = wb.active
            ws.title = "ANPR Logs"
            ws.append(["Plate Number", "Date", "Time", "Image Path"])
            wb.save(self.excel_file)

    def load_models(self):
        """Load YOLO and TrOCR models. Call once at startup."""
        if self.loaded:
            return
        model_path = os.path.join(self.base_dir, "model", "best.pt")
        self.model = YOLO(model_path)
        self.processor = TrOCRProcessor.from_pretrained("microsoft/trocr-base-printed")
        self.ocr_model = VisionEncoderDecoderModel.from_pretrained("microsoft/trocr-base-printed")
        self.loaded = True
        print("✅ Models loaded successfully")

    # ── Plate Cleaning ───────────────────────────────────────

    @staticmethod
    def clean_plate(text):
        """Clean and validate Indian-format number plate text."""
        text = text.upper()
        text = re.sub(r'[^A-Z0-9]', '', text)

        text = list(text)
        for i, c in enumerate(text):
            if i < 2:
                if c == '0':
                    text[i] = 'O'
            elif 2 <= i < 4:
                if c == 'O':
                    text[i] = '0'
            else:
                if c == 'O':
                    text[i] = '0'
                if c == 'I':
                    text[i] = '1'

        text = "".join(text)
        match = re.findall(r'[A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}', text)
        return match[0] if match else ""

    # ── Data Persistence ─────────────────────────────────────

    def save_plate_data(self, plate, plate_img):
        """Save plate image to disk and log to Excel. Returns True if new."""
        if plate in self.saved_plates:
            return False

        self.saved_plates.add(plate)
        now = datetime.now()
        date_str = now.strftime("%Y-%m-%d")
        time_str = now.strftime("%H-%M-%S")

        image_name = f"{plate}_{time_str}.jpg"
        image_path = os.path.join(self.image_dir, image_name)
        cv2.imwrite(image_path, plate_img)

        wb = load_workbook(self.excel_file)
        ws = wb.active
        ws.append([plate, date_str, time_str, image_path])
        wb.save(self.excel_file)

        print(f"📸 Saved: {image_name}")
        return True

    # ── OCR ──────────────────────────────────────────────────

    def read_plate_text(self, plate_img):
        """Run TrOCR on a cropped plate image, return raw text."""
        try:
            gray = cv2.cvtColor(plate_img, cv2.COLOR_BGR2GRAY)
            gray = cv2.resize(gray, None, fx=3, fy=3)
            rgb = cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB)
            pil_img = Image.fromarray(rgb)

            pixel_values = self.processor(images=pil_img, return_tensors="pt").pixel_values
            generated_ids = self.ocr_model.generate(pixel_values)
            text = self.processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
            return text
        except Exception as e:
            print(f"OCR Error: {e}")
            return ""

    # ── Frame Processing ─────────────────────────────────────

    def process_frame(self, frame, direct_save=False):
        """
        Detect plates in a single frame.

        Args:
            frame: BGR numpy array
            direct_save: if True, save plate immediately (image mode);
                         if False, use 3-frame memory (webcam/video mode)

        Returns:
            dict with annotated_frame (base64) and plates list
        """
        self.load_models()
        results = self.model(frame, conf=0.25)
        detected_plates = []

        for box in results[0].boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            conf = float(box.conf[0])

            # Pad the crop
            pad = 20
            x1p = max(0, x1 - pad)
            y1p = max(0, y1 - pad)
            x2p = min(frame.shape[1], x2 + pad)
            y2p = min(frame.shape[0], y2 + pad)

            plate_img = frame[y1p:y2p, x1p:x2p]
            if plate_img.size == 0:
                continue

            raw_text = self.read_plate_text(plate_img)
            cleaned = self.clean_plate(raw_text)

            saved = False
            if cleaned:
                if direct_save:
                    saved = self.save_plate_data(cleaned, plate_img)
                else:
                    self.plate_memory[cleaned] = self.plate_memory.get(cleaned, 0) + 1
                    if self.plate_memory[cleaned] >= 3:
                        saved = self.save_plate_data(cleaned, plate_img)
                        self.plate_memory[cleaned] = 0

            # Draw bounding box and label on frame
            color = (0, 255, 0) if cleaned else (0, 0, 255)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            if cleaned:
                label = cleaned
                (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
                cv2.rectangle(frame, (x1, y1 - th - 10), (x1 + tw, y1), color, -1)
                cv2.putText(frame, label, (x1, y1 - 5),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)

            # Encode cropped plate as base64
            _, plate_buf = cv2.imencode('.jpg', plate_img)
            plate_b64 = base64.b64encode(plate_buf).decode('utf-8')

            detected_plates.append({
                "raw_text": raw_text,
                "cleaned_text": cleaned,
                "confidence": round(conf, 2),
                "bbox": [x1, y1, x2, y2],
                "plate_image": plate_b64,
                "saved": saved,
            })

        # Encode annotated frame as base64
        _, frame_buf = cv2.imencode('.jpg', frame)
        frame_b64 = base64.b64encode(frame_buf).decode('utf-8')

        return {
            "annotated_frame": frame_b64,
            "plates": detected_plates,
        }

    # ── High-Level Helpers ───────────────────────────────────

    def process_image_bytes(self, image_bytes):
        """Process an uploaded image (bytes). Saves detections immediately."""
        nparr = np.frombuffer(image_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            return {"error": "Could not decode image"}
        return self.process_frame(frame, direct_save=True)

    def process_video_file(self, video_path, frame_skip=10):
        """
        Process a video file. Samples every `frame_skip` frames.
        Returns a list of all unique plates found + a sample annotated frame.
        """
        self.load_models()
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return {"error": "Could not open video"}

        all_plates = {}
        sample_frame_b64 = None
        frame_count = 0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            frame_count += 1
            if frame_count % frame_skip != 0:
                continue

            result = self.process_frame(frame, direct_save=False)

            # Keep the first annotated frame that has detections
            if result["plates"] and sample_frame_b64 is None:
                sample_frame_b64 = result["annotated_frame"]

            for p in result["plates"]:
                text = p["cleaned_text"]
                if text and text not in all_plates:
                    all_plates[text] = p

        cap.release()

        # Now save all unique plates that passed the memory threshold
        # For video, also directly save anything detected more than once
        unique_plates = list(all_plates.values())
        for p in unique_plates:
            if p["cleaned_text"]:
                # Decode plate image for saving
                plate_bytes = base64.b64decode(p["plate_image"])
                nparr = np.frombuffer(plate_bytes, np.uint8)
                plate_img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                saved = self.save_plate_data(p["cleaned_text"], plate_img)
                p["saved"] = saved

        return {
            "annotated_frame": sample_frame_b64,
            "plates": unique_plates,
            "frames_processed": frame_count // frame_skip,
            "total_frames": total_frames,
        }

    def get_logs(self):
        """Read detection history from the Excel log."""
        if not os.path.exists(self.excel_file):
            return []
        wb = load_workbook(self.excel_file)
        ws = wb.active
        logs = []
        for row in ws.iter_rows(min_row=2, values_only=True):
            if row[0]:
                logs.append({
                    "plate": str(row[0]),
                    "date": str(row[1]) if row[1] else "",
                    "time": str(row[2]) if row[2] else "",
                })
        return logs
