from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas

OUTPUT = Path(__file__).resolve().parents[1] / "output" / "pdf"
OUTPUT.mkdir(parents=True, exist_ok=True)

DOCUMENTS = [
    ("test-brand-operating-license.pdf", "Operating License", "DEMO-BRAND-0001", "Expires 12/31/2027"),
    ("test-brand-master-service-agreement.pdf", "Master Service Agreement", "Version 1.0", "Effective 01/01/2026"),
    ("test-brand-w9.pdf", "W-9 / Tax Record", "EIN 00-0000000", "Demo record only"),
    ("test-brand-brand-guidelines.pdf", "Brand Guidelines", "Version 1.0", "Approved demo asset"),
    ("test-brand-nda.pdf", "Non-Disclosure Agreement", "Version 1.0", "Effective 01/01/2026"),
    ("test-brand-pricing-fee-schedule.pdf", "Pricing / Fee Schedule", "Version 1.0", "Effective 01/01/2026"),
    ("test-brand-insurance.pdf", "Insurance Certificate", "Policy DEMO-INS-2026", "Expires 12/31/2027"),
]

DISCLAIMER = "DEMO — NOT A VALID AGREEMENT, LICENSE, INVOICE, OR CERTIFICATE"


def draw_document(path: Path, title: str, reference: str, detail: str) -> None:
    width, height = LETTER
    pdf = canvas.Canvas(str(path), pagesize=LETTER)
    pdf.setTitle(f"Test Brand — {title}")
    pdf.setFillColor(colors.HexColor("#F7F3EF"))
    pdf.rect(0, 0, width, height, fill=1, stroke=0)
    pdf.setFillColor(colors.HexColor("#17633B"))
    pdf.rect(0, height - 92, width, 92, fill=1, stroke=0)
    pdf.setFillColor(colors.white)
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawString(42, height - 42, "TEST BRAND")
    pdf.setFont("Helvetica", 9)
    pdf.drawString(42, height - 62, "urbanXtracts Brand Workspace Demonstration")

    pdf.setFillColor(colors.HexColor("#17100D"))
    pdf.setFont("Helvetica-Bold", 27)
    pdf.drawString(42, height - 158, title)
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawString(42, height - 198, reference)
    pdf.setFont("Helvetica", 11)
    pdf.drawString(42, height - 220, detail)

    pdf.setStrokeColor(colors.HexColor("#C9C0B9"))
    pdf.line(42, height - 250, width - 42, height - 250)
    pdf.setFont("Helvetica", 10)
    text = pdf.beginText(42, height - 286)
    text.setLeading(17)
    for line in [
        "This synthetic file demonstrates the Brand Workspace document register,",
        "individual download, ZIP export, version history, and internal review flow.",
        "It contains no real company, license, tax, banking, customer, or contract data.",
    ]:
        text.textLine(line)
    pdf.drawText(text)

    pdf.saveState()
    pdf.translate(width / 2, height / 2)
    pdf.rotate(32)
    pdf.setFillColor(colors.Color(0.64, 0.17, 0.08, alpha=0.10))
    pdf.setFont("Helvetica-Bold", 40)
    pdf.drawCentredString(0, 0, "DEMO — NOT VALID")
    pdf.restoreState()

    pdf.setFillColor(colors.HexColor("#A33116"))
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawCentredString(width / 2, 48, DISCLAIMER)
    pdf.showPage()
    pdf.save()


for filename, title, reference, detail in DOCUMENTS:
    draw_document(OUTPUT / filename, title, reference, detail)

print("\n".join(str(OUTPUT / filename) for filename, *_ in DOCUMENTS))
