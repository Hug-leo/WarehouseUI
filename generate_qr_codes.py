"""
Generate printable QR codes for warehouse rack locations.
Each QR code contains a location_code that matches the Locations table.

Run:  python generate_qr_codes.py

Output: qr_codes/ folder with individual PNGs + one print sheet.
"""

import os
import requests
import qrcode
from PIL import Image, ImageDraw, ImageFont


# Change this to your actual backend server URL if not running locally
BACKEND_URL = "http://localhost:8000/locations"

OUTPUT_DIR = "qr_codes"
QR_SIZE = 300  # pixels per individual QR image
LABEL_HEIGHT = 50  # space below QR for the text label


def fetch_locations():
    """Fetch all shelf locations from the backend API."""
    resp = requests.get(BACKEND_URL)
    resp.raise_for_status()
    # The API returns a list of dicts with keys: location_code, rack, slot, ...
    locations = resp.json()
    return [
        (loc["location_code"], loc.get("rack", ""), loc.get("slot", ""))
        for loc in locations
    ]


def make_qr(location_code: str) -> Image.Image:
    """Generate one QR code image with a text label underneath."""
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=10,
        border=2,
    )
    qr.add_data(location_code)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    qr_img = qr_img.resize((QR_SIZE, QR_SIZE), Image.NEAREST)

    # Create card with label
    card = Image.new("RGB", (QR_SIZE, QR_SIZE + LABEL_HEIGHT), "white")
    card.paste(qr_img, (0, 0))

    draw = ImageDraw.Draw(card)
    try:
        font = ImageFont.truetype("arial.ttf", 22)
    except OSError:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), location_code, font=font)
    tw = bbox[2] - bbox[0]
    tx = (QR_SIZE - tw) // 2
    draw.text((tx, QR_SIZE + 8), location_code, fill="black", font=font)

    return card


def make_print_sheet(cards: list[Image.Image]) -> Image.Image:
    """Arrange all QR cards into a printable A4-ish grid (3 columns)."""
    cols = 3
    rows = (len(cards) + cols - 1) // cols
    card_w, card_h = cards[0].size
    margin = 30
    sheet_w = cols * card_w + (cols + 1) * margin
    sheet_h = rows * card_h + (rows + 1) * margin

    sheet = Image.new("RGB", (sheet_w, sheet_h), "white")

    for i, card in enumerate(cards):
        r, c = divmod(i, cols)
        x = margin + c * (card_w + margin)
        y = margin + r * (card_h + margin)
        sheet.paste(card, (x, y))

    return sheet


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    cards = []

    print(f"Fetching locations from {BACKEND_URL} ...")
    try:
        locations = fetch_locations()
    except requests.exceptions.ConnectionError:
        print(f"ERROR: Could not connect to {BACKEND_URL}")
        print("Make sure your backend server is running before running this script.")
        return
    except requests.exceptions.HTTPError as e:
        print(f"ERROR: Server returned an error: {e}")
        return

    if not locations:
        print(
            "No shelf locations found in the database. Please add shelves to the Locations table first."
        )
        return

    for loc_code, rack, slot in locations:
        card = make_qr(loc_code)
        card.save(os.path.join(OUTPUT_DIR, f"{loc_code}.png"))
        cards.append(card)
        print(f"  [OK] {loc_code}  (Rack {rack}, Slot {slot})")

    # Print sheet
    sheet = make_print_sheet(cards)
    sheet_path = os.path.join(OUTPUT_DIR, "_PRINT_SHEET.png")
    sheet.save(sheet_path)

    print(f"\n{'='*50}")
    print(f"  Generated {len(cards)} QR codes in '{OUTPUT_DIR}/'")
    print(f"  Print sheet: {sheet_path}")
    print(f"{'='*50}")
    print(f"\n  Locations in the database:")
    print(f"  {'Location Code':<16} {'Rack':<6} {'Slot'}")
    print(f"  {'-'*16} {'-'*6} {'-'*4}")
    for loc_code, rack, slot in locations:
        print(f"  {loc_code:<16} {rack:<6} {slot}")


if __name__ == "__main__":
    main()
