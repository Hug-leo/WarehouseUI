from flask import Flask, Response
import cv2

app = Flask(__name__)
cap = cv2.VideoCapture(0)


def gen():
    while True:
        ret, frame = cap.read()
        _, buffer = cv2.imencode(".jpg", frame)
        frame = buffer.tobytes()
        yield (b"--frame\r\n" b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n")


@app.route("/video")
def video():
    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame")


app.run(host="0.0.0.0", port=5001)
