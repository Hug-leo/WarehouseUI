"""
Generate printable QR codes for warehouse rack locations.
Each QR code contains a location_code that matches the Locations table.

Run:  python generate_qr_codes.py

Output: qr_codes/ folder with individual PNGs + one print sheet.
"""

import os
import qrcode
from PIL import Image, ImageDraw, ImageFont

# ── Define your warehouse locations here ──────────────────────
# Format: (location_code, rack, slot)
# The location_code is what goes INSIDE the QR code.
LOCATIONS = [
    ("RACK_A_01", "A", "01"),
    ("RACK_A_02", "A", "02"),
    ("RACK_A_03", "A", "03"),
    ("RACK_B_01", "B", "01"),
    ("RACK_B_02", "B", "02"),
    ("RACK_B_03", "B", "03"),
    ("RACK_C_01", "C", "01"),
    ("RACK_C_02", "C", "02"),
    ("RACK_C_03", "C", "03"),
    ("RACK_D_01", "D", "01"),
    ("RACK_D_02", "D", "02"),
    ("RACK_D_03", "D", "03"),
]

OUTPUT_DIR = "qr_codes"
QR_SIZE = 300  # pixels per individual QR image
LABEL_HEIGHT = 50  # space below QR for the text label


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

    for loc_code, rack, slot in LOCATIONS:
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
    print(f"\n  Now add these locations in the dashboard:")
    print(f"  {'Location Code':<16} {'Rack':<6} {'Slot'}")
    print(f"  {'-'*16} {'-'*6} {'-'*4}")
    for loc_code, rack, slot in LOCATIONS:
        print(f"  {loc_code:<16} {rack:<6} {slot}")


if __name__ == "__main__":
    main()
