"""Build the Shop UrbanXtracts product catalog XLSX from the browser-verified snapshot.

Standard library only (no spreadsheet package is installed). Output is
deterministic: fixed ZIP timestamps, source row order, first-seen shared strings.

    python3 -I scripts/build_product_catalog_xlsx.py SOURCE.json OUT.xlsx
    python3 -I scripts/build_product_catalog_xlsx.py SOURCE.json OUT.xlsx --verify

--verify reopens OUT.xlsx from disk and checks it against SOURCE.json without
reusing anything the builder computed.
"""
import json
import re
import sys
import zipfile
from collections import Counter, OrderedDict
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

# Display-only alias confirmed by the business. Raw source brand is kept in its own column.
BRAND_DISPLAY_ALIASES = {"Cannaprints": "Cannaprint"}
MISSING_DETAIL = "MISSING - NOT IN SOURCE"
NO_IMAGE = "NO IMAGE IN SOURCE"
ZIP_TIME = (2026, 10, 14, 0, 0, 0)

YELLOW = "FFFFEB9C"
RED = "FFFFC7CE"
RED_TEXT = "FF9C0006"
HEADER = "FFE7ECE4"
LINK = "FF0563C1"

COLUMNS = [
    # header, width, kind
    ("Marketplace Product ID", 13, "id"),
    ("Product GID", 26, "clip"),
    ("Product Name", 48, "wrap"),
    ("Canonical Brand", 17, "wrap"),
    ("Original Source Brand", 17, "wrap"),
    ("Category", 24, "wrap"),
    ("Source Price Cents", 11, "int"),
    ("Source Price USD", 11, "usd"),
    ("Source Displayed Availability", 13, "count"),
    ("Sale Unit", 8, "text"),
    ("Minimum Order Quantity", 11, "int"),
    ("Image URL", 30, "link"),
    ("Image Status", 16, "image"),
    ("Image / Placeholder", 20, "image"),
    ("SKU", 15, "missing"),
    ("Pack / Case Size", 15, "missing"),
    ("Release Detail", 15, "missing"),
    ("Product URL", 30, "link"),
]

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
HYPERLINK_TYPE = REL_NS + "/hyperlink"

# cellXfs indexes; must match STYLES_XML order.
S_DEFAULT, S_HEADER, S_WRAP, S_CLIP, S_INT, S_USD, S_COUNT, S_LINK, S_YELLOW, S_YELLOW_LINK, S_RED, \
    S_TITLE, S_SECTION, S_LABEL, S_NOTE, S_YELLOW_SWATCH, S_RED_SWATCH, S_TABLE_HEAD, S_CENTER_INT = range(19)

STYLES_XML = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="{NS}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
<fonts count="7">
<font><sz val="10"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="FF1F2A1F"/><name val="Calibri"/><family val="2"/></font>
<font><u/><sz val="10"/><color rgb="{LINK}"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="{RED_TEXT}"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="14"/><color rgb="FF1F2A1F"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF1F2A1F"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="FF7F6000"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="{HEADER}"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="{YELLOW}"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="{RED}"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFB7C2B3"/></bottom><diagonal/></border>
<border><left/><right/><top/><bottom style="hair"><color rgb="FFD9D9D9"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="19">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="6" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="3" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="6" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>
"""


def col_letter(index):
    letters = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


class Strings:
    def __init__(self):
        self.index = OrderedDict()

    def ref(self, value):
        if value not in self.index:
            self.index[value] = len(self.index)
        return self.index[value]

    def xml(self, total):
        items = []
        for value in self.index:
            space = ' xml:space="preserve"' if value != value.strip() or "\n" in value else ""
            items.append(f"<si><t{space}>{escape(value)}</t></si>")
        return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="{NS}" count="{total}" '
                f'uniqueCount="{len(self.index)}">{"".join(items)}</sst>')


class Sheet:
    def __init__(self, strings):
        self.strings = strings
        self.rows = []
        self.links = []
        self.string_cells = 0

    def row(self, cells, height=None):
        """cells: list of (value, style) or None; value str -> shared string, int/float -> number."""
        number = len(self.rows) + 1
        parts = []
        for col, cell in enumerate(cells):
            if cell is None:
                continue
            value, style = cell[0], cell[1]
            ref = f"{col_letter(col)}{number}"
            if value is None or value == "":
                parts.append(f'<c r="{ref}" s="{style}"/>')
            elif isinstance(value, bool):
                raise TypeError(ref)
            elif isinstance(value, (int, float)):
                parts.append(f'<c r="{ref}" s="{style}"><v>{value!r}</v></c>')
            else:
                self.string_cells += 1
                parts.append(f'<c r="{ref}" s="{style}" t="s"><v>{self.strings.ref(value)}</v></c>')
            if len(cell) > 2 and cell[2]:
                self.links.append((ref, cell[2]))
        attrs = f' ht="{height}" customHeight="1"' if height else ""
        self.rows.append(f'<row r="{number}"{attrs}>{"".join(parts)}</row>')
        return number

    def xml(self, widths, last_col, freeze=None, autofilter=None, ignore_text_numbers=None):
        dim = f"A1:{last_col}{len(self.rows)}"
        if freeze:
            x, y = freeze
            top_left = f"{col_letter(x)}{y + 1}"
            pane_name = "bottomRight" if x and y else ("bottomLeft" if y else "topRight")
            xs = f' xSplit="{x}"' if x else ""
            ys = f' ySplit="{y}"' if y else ""
            view = (f'<sheetView workbookViewId="0" zoomScale="100"><pane{xs}{ys} topLeftCell="{top_left}" activePane="{pane_name}" '
                    f'state="frozen"/><selection pane="{pane_name}" activeCell="{top_left}" sqref="{top_left}"/></sheetView>')
        else:
            view = '<sheetView workbookViewId="0" zoomScale="100"/>'
        cols = "".join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths))
        out = [f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="{NS}" xmlns:r="{REL_NS}">',
               f'<dimension ref="{dim}"/><sheetViews>{view}</sheetViews><sheetFormatPr defaultRowHeight="13.5"/>',
               f"<cols>{cols}</cols><sheetData>{''.join(self.rows)}</sheetData>"]
        if autofilter:
            out.append(f'<autoFilter ref="{autofilter}"/>')
        if self.links:
            out.append("<hyperlinks>" + "".join(f'<hyperlink ref="{ref}" r:id="rId{i + 1}"/>' for i, (ref, _) in enumerate(self.links)) + "</hyperlinks>")
        out.append('<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>')
        out.append('<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>')
        if ignore_text_numbers:
            out.append(f'<ignoredErrors><ignoredError sqref="{ignore_text_numbers}" numberStoredAsText="1"/></ignoredErrors>')
        out.append("</worksheet>")
        return "".join(out)

    def rels_xml(self):
        rels = "".join(f'<Relationship Id="rId{i + 1}" Type="{HYPERLINK_TYPE}" Target="{escape(url, {chr(34): "&quot;"})}" TargetMode="External"/>'
                       for i, (_, url) in enumerate(self.links))
        return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{PKG_REL_NS}">{rels}</Relationships>'


def load(source_path):
    with open(source_path, encoding="utf-8") as handle:
        snapshot = json.load(handle)
    source, products = snapshot["source"], snapshot["products"]
    if source.get("sourceMode") != "browser_verified_snapshot" or source.get("snapshotScope") != "full_shop":
        raise SystemExit("Source is not a browser-verified full-shop snapshot.")
    if not (len(products) == source["declaredProductCount"] == source["capturedProductCount"]):
        raise SystemExit("Snapshot product count does not match declared and captured counts.")
    if len({p["marketplaceProductId"] for p in products}) != len(products):
        raise SystemExit("Duplicate Marketplace Product IDs in source.")
    for p in products:
        if p["hasImage"] != bool(p["imageUrl"]):
            raise SystemExit(f"Product {p['marketplaceProductId']} has inconsistent image fields.")
        for field in ("sku", "packSize", "caseSize", "releaseStatus", "released"):
            if field in p:
                raise SystemExit(f"Source now carries {field}; this export would mislabel it as missing.")
    return source, products


def build(source_path, out_path):
    source, products = load(source_path)
    strings = Strings()

    # Products
    sheet = Sheet(strings)
    sheet.row([(name, S_HEADER) for name, _, _ in COLUMNS], height=30)
    for p in products:
        has_image = bool(p["hasImage"] and p["imageUrl"])
        raw_brand = p["brandName"]
        sheet.row([
            (p["marketplaceProductId"], S_CLIP),
            (p["productGid"], S_CLIP),
            (p["productName"], S_WRAP),
            (BRAND_DISPLAY_ALIASES.get(raw_brand, raw_brand), S_WRAP),
            (raw_brand, S_WRAP),
            (p["itemCategoryName"], S_WRAP),
            (p["priceCents"], S_INT),
            (p["priceCents"] / 100, S_USD),
            (p["availableQuantity"], S_COUNT),
            (p["saleUnit"], S_CLIP),
            (p["minimumOrderQuantity"], S_INT),
            (p["imageUrl"], S_LINK, p["imageUrl"]) if has_image else ("", S_CLIP),
            ("Image in source", S_CLIP) if has_image else ("Missing", S_YELLOW),
            ("View image", S_LINK, p["imageUrl"]) if has_image else (NO_IMAGE, S_YELLOW),
            (MISSING_DETAIL, S_RED),
            (MISSING_DETAIL, S_RED),
            (MISSING_DETAIL, S_RED),
            (p["productUrl"], S_LINK, p["productUrl"]),
        ])
    last_col = col_letter(len(COLUMNS) - 1)
    last_row = len(products) + 1
    products_xml = sheet.xml([w for _, w, _ in COLUMNS], last_col, freeze=(3, 1),
                             autofilter=f"A1:{last_col}{last_row}", ignore_text_numbers=f"A2:A{last_row}")

    # Legend
    raw_counts = Counter(p["brandName"] for p in products)
    canonical = OrderedDict()
    for raw in sorted(raw_counts, key=lambda b: (BRAND_DISPLAY_ALIASES.get(b, b).lower(), b)):
        canonical.setdefault(BRAND_DISPLAY_ALIASES.get(raw, raw), []).append(raw)
    with_image = sum(1 for p in products if p["hasImage"])
    categories = len({p["itemCategoryName"] for p in products})
    cannaprint_raw = canonical.get("Cannaprint", [])
    cannaprint_rows = sum(raw_counts[b] for b in cannaprint_raw)
    split = " + ".join(f"{raw_counts[b]} raw {b}" for b in cannaprint_raw)

    legend = Sheet(strings)
    legend.row([("Shop UrbanXtracts Product Catalog — Read Me", S_TITLE)], height=22)
    legend.row([("Internal working export of the Canix Marketplace listing snapshot. Source values are copied as captured; nothing is invented.", S_NOTE)])
    legend.row([])
    legend.row([("Color key", S_SECTION), ("", S_SECTION)])
    legend.row([("Yellow — missing image", S_YELLOW_SWATCH),
                (f"Image Status and Image / Placeholder cells for the {len(products) - with_image} listings with no image in the source. "
                 f"The placeholder cell reads {NO_IMAGE}; Image URL is blank because the source value is empty.", S_NOTE)])
    legend.row([("Red — missing detail", S_RED_SWATCH),
                (f"SKU, Pack / Case Size and Release Detail are not in the source for any of the {len(products)} listings. "
                 f"Every one of those cells reads {MISSING_DETAIL}. They have not been looked up or inferred.", S_NOTE)])
    legend.row([])
    legend.row([("Provenance", S_SECTION), ("", S_SECTION)])
    for label, value in [
        ("Shop", f"Shop UrbanXtracts ({source['sourceUrl']})"),
        ("Snapshot", f"Browser-verified full-shop snapshot captured {source['capturedAt']} (2026-10-14). "
                     f"sourceMode={source['sourceMode']}, snapshotScope={source['snapshotScope']}."),
        ("Source file", f"data/canix-marketplace-listings-2026-10-14.json in UX-Portal (sync run {source['syncRunId']})."),
        ("Not live inventory", "Source Displayed Availability is the listing quantity shown at capture. It is not live inventory and is not "
                               "a Canix package, Metrc or QuickBooks figure. Re-check Canix before quoting availability."),
        ("Prices", "Source Price Cents is the captured listing price; Source Price USD is that value ÷ 100. Not cost, not a rate card."),
        ("Units", "Sale Unit is the source listing unit as shown (\"each\"). Availability and minimums are per listing and are not summed "
                  "across products. Minimum Order Quantity is a minimum, not an order multiple."),
        ("Omitted source field", "msrpCents (empty for 118 listings) is not exported."),
    ]:
        legend.row([(label, S_LABEL), (value, S_NOTE)])
    legend.row([])
    legend.row([("Counts", S_SECTION), ("", S_SECTION)])
    for label, value in [
        ("Product rows", f"{len(products)} data rows on Products (row 1 is the header); {len({p['marketplaceProductId'] for p in products})} unique Marketplace Product IDs."),
        ("Images", f"{with_image} with an image URL in source; {len(products) - with_image} without (yellow)."),
        ("Categories", f"{categories} source categories."),
        ("Brands", f"{len(canonical)} canonical brands; {len(raw_counts)} raw source brand strings."),
        ("Cannaprint", f"Canonical Cannaprint = {cannaprint_rows} rows ({split}). The business confirmed these are the same brand. "
                       "Original Source Brand keeps the raw value; Marketplace Product IDs are unchanged and not merged."),
    ]:
        legend.row([(label, S_LABEL), (value, S_NOTE)])
    legend.row([])
    legend.row([("Canonical Brand", S_TABLE_HEAD), ("Rows", S_TABLE_HEAD), ("Raw source brand strings", S_TABLE_HEAD)])
    for name, raws in canonical.items():
        legend.row([(name, S_WRAP), (sum(raw_counts[b] for b in raws), S_CENTER_INT),
                    (", ".join(f"{b} ({raw_counts[b]})" for b in raws), S_WRAP)])
    legend.row([("Total", S_LABEL), (len(products), S_CENTER_INT), ("", S_WRAP)])
    legend.row([])
    legend.row([("Handling", S_SECTION), ("", S_SECTION)])
    legend.row([("Before sharing", S_LABEL),
                ("This sheet lists every brand's listings and prices together. Review scope before sending it to any brand, store or outside party.", S_NOTE)])
    legend_xml = legend.xml([30, 110, 60], "C")

    total_strings = sheet.string_cells + legend.string_cells
    filter_name = f"Products!$A$1:${last_col}${last_row}"
    workbook = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="{NS}" xmlns:r="{REL_NS}">'
                '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="17000" activeTab="0"/></bookViews>'
                '<sheets><sheet name="Products" sheetId="1" r:id="rId1"/><sheet name="Read Me" sheetId="2" r:id="rId2"/></sheets>'
                f'<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">{filter_name}</definedName></definedNames>'
                "</workbook>")
    wb_rels = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{PKG_REL_NS}">'
               f'<Relationship Id="rId1" Type="{REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>'
               f'<Relationship Id="rId2" Type="{REL_NS}/worksheet" Target="worksheets/sheet2.xml"/>'
               f'<Relationship Id="rId3" Type="{REL_NS}/styles" Target="styles.xml"/>'
               f'<Relationship Id="rId4" Type="{REL_NS}/sharedStrings" Target="sharedStrings.xml"/>'
               "</Relationships>")
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                     '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                     '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                     '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                     '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
                     '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
                     '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
                     "</Types>")
    root_rels = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{PKG_REL_NS}">'
                 f'<Relationship Id="rId1" Type="{REL_NS}/officeDocument" Target="xl/workbook.xml"/>'
                 '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
                 f'<Relationship Id="rId3" Type="{REL_NS}/extended-properties" Target="docProps/app.xml"/>'
                 "</Relationships>")
    core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            "<dc:title>Shop UrbanXtracts Product Catalog</dc:title><dc:creator>UrbanXtracts</dc:creator>"
            "<dc:description>From the 2026-10-14 browser-verified Canix Marketplace listing snapshot. Not live inventory.</dc:description>"
            '<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-14T00:00:00Z</dcterms:created>'
            '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-14T00:00:00Z</dcterms:modified>'
            "</cp:coreProperties>")
    app = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
           '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
           'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
           "<Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>"
           '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>'
           '<vt:variant><vt:i4>2</vt:i4></vt:variant></vt:vector></HeadingPairs>'
           '<TitlesOfParts><vt:vector size="2" baseType="lpstr"><vt:lpstr>Products</vt:lpstr><vt:lpstr>Read Me</vt:lpstr></vt:vector></TitlesOfParts>'
           "</Properties>")

    parts = [
        ("[Content_Types].xml", content_types),
        ("_rels/.rels", root_rels),
        ("docProps/core.xml", core),
        ("docProps/app.xml", app),
        ("xl/workbook.xml", workbook),
        ("xl/_rels/workbook.xml.rels", wb_rels),
        ("xl/styles.xml", STYLES_XML),
        ("xl/sharedStrings.xml", strings.xml(total_strings)),
        ("xl/worksheets/sheet1.xml", products_xml),
        ("xl/worksheets/_rels/sheet1.xml.rels", sheet.rels_xml()),
        ("xl/worksheets/sheet2.xml", legend_xml),
    ]
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts:
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data.encode("utf-8"))
    print(f"Wrote {out_path} ({len(products)} products, {len(sheet.links)} hyperlinks).")


def verify(source_path, out_path):
    """Reopen the workbook from disk and check it against the source snapshot."""
    _, products = load(source_path)
    q = lambda tag: f"{{{NS}}}{tag}"
    failures = []

    def check(condition, message):
        print(("PASS " if condition else "FAIL ") + message)
        if not condition:
            failures.append(message)

    with zipfile.ZipFile(out_path) as archive:
        check(archive.testzip() is None, "ZIP CRCs valid")
        names = archive.namelist()
        check(len(names) == len(set(names)), "no duplicate ZIP entries")
        parsed = {}
        for name in names:
            parsed[name] = ET.fromstring(archive.read(name))  # raises on malformed XML
        check(True, f"all {len(names)} parts parse as XML")
        check(not any("repair" in n.lower() or n.startswith("xl/revisions") for n in names), "no repair/revision parts")
        types = parsed["[Content_Types].xml"]
        overrides = {e.get("PartName").lstrip("/") for e in types if e.tag.endswith("Override")}
        check(all(n in names for n in overrides), "every content-type override has a part")
        rel_ns = f"{{{PKG_REL_NS}}}Relationship"
        for rels_name in [n for n in names if n.endswith(".rels")]:
            base = rels_name.replace("_rels/", "").replace(".rels", "")
            folder = base.rsplit("/", 1)[0] + "/" if "/" in base else ""
            for rel in parsed[rels_name].iter(rel_ns):
                if rel.get("TargetMode") != "External":
                    check(folder + rel.get("Target") in names, f"{rels_name} target {rel.get('Target')} exists")

        sst = [("".join(t.text or "" for t in si.iter(q("t")))) for si in parsed["xl/sharedStrings.xml"].iter(q("si"))]
        styles = parsed["xl/styles.xml"]
        fills = []
        for fill in styles.find(q("fills")):
            fg = fill.find(f"{q('patternFill')}/{q('fgColor')}")
            fills.append(fg.get("rgb") if fg is not None else None)
        xfs = [int(xf.get("fillId")) for xf in styles.find(q("cellXfs"))]
        check(styles.find(q("cellXfs")).get("count") == str(len(xfs)), "cellXfs count attribute matches")

        workbook = parsed["xl/workbook.xml"]
        sheet_names = [s.get("name") for s in workbook.iter(q("sheet"))]
        check(sheet_names == ["Products", "Read Me"], f"sheets are {sheet_names}")

        ws = parsed["xl/worksheets/sheet1.xml"]
        rows = {}
        for row in ws.iter(q("row")):
            cells = {}
            for c in row.iter(q("c")):
                letters = re.match(r"[A-Z]+", c.get("r")).group(0)
                v = c.find(q("v"))
                value = None if v is None else (sst[int(v.text)] if c.get("t") == "s" else float(v.text))
                cells[letters] = (value, fills[xfs[int(c.get("s", "0"))]])
            rows[int(row.get("r"))] = cells
        header = {k: v[0] for k, v in rows[1].items()}
        col = {name: letter for letter, name in header.items()}
        check([header[col_letter(i)] for i in range(len(COLUMNS))] == [c[0] for c in COLUMNS], "Products header matches the required columns")
        data = [rows[r] for r in sorted(rows) if r > 1]
        check(len(data) == 120 == len(products), f"{len(data)} product data rows")

        get = lambda r, name: r[col[name]][0]
        fill = lambda r, name: r[col[name]][1]
        exact = all(
            get(r, "Marketplace Product ID") == p["marketplaceProductId"] and get(r, "Product GID") == p["productGid"]
            and get(r, "Product Name") == p["productName"] and get(r, "Original Source Brand") == p["brandName"]
            and get(r, "Category") == p["itemCategoryName"] and get(r, "Source Price Cents") == p["priceCents"]
            and abs(get(r, "Source Price USD") - p["priceCents"] / 100) < 1e-9
            and get(r, "Source Displayed Availability") == p["availableQuantity"] and get(r, "Sale Unit") == p["saleUnit"]
            and get(r, "Minimum Order Quantity") == p["minimumOrderQuantity"] and (get(r, "Image URL") or None) == (p["imageUrl"] or None)
            and get(r, "Product URL") == p["productUrl"]
            for r, p in zip(data, products))
        check(exact, "every row matches the source record in source order")

        canonical = Counter(get(r, "Canonical Brand") for r in data)
        raw = Counter(get(r, "Original Source Brand") for r in data)
        check(len(canonical) == 13, f"{len(canonical)} canonical brands")
        check(len(raw) == 14, f"{len(raw)} raw source brand strings")
        check("Cannaprints" not in canonical, "no canonical 'Cannaprints'")
        cp = [r for r in data if get(r, "Canonical Brand") == "Cannaprint"]
        cp_raw = Counter(get(r, "Original Source Brand") for r in cp)
        check(len(cp) == 6 and cp_raw == Counter({"Cannaprint": 4, "Cannaprints": 2}), f"Cannaprint rows {len(cp)} split {dict(cp_raw)}")
        check(all(get(r, "Canonical Brand") == BRAND_DISPLAY_ALIASES.get(get(r, "Original Source Brand"), get(r, "Original Source Brand")) for r in data),
              "canonical brand differs from raw only for the Cannaprints alias")

        missing = [r for r in data if not get(r, "Image URL")]
        present = [r for r in data if get(r, "Image URL")]
        check(len(present) == 98 and len(missing) == 22, f"images {len(present)} present / {len(missing)} missing")
        yellow_cells = sum(1 for r in data for name in ("Image Status", "Image / Placeholder") if fill(r, name) == YELLOW)
        yellow_rows = sum(1 for r in missing if fill(r, "Image Status") == YELLOW and fill(r, "Image / Placeholder") == YELLOW
                          and get(r, "Image / Placeholder") == NO_IMAGE)
        check(yellow_rows == 22 and yellow_cells == 44, f"{yellow_rows} yellow missing-image rows, {yellow_cells} yellow cells")
        check(all(fill(r, name) != YELLOW for r in present for name in ("Image Status", "Image / Placeholder")), "no yellow on rows with images")
        all_yellow = sum(1 for r in data for v in r.values() if v[1] == YELLOW)
        check(all_yellow == 44, f"yellow appears only in those cells ({all_yellow})")
        for name in ("SKU", "Pack / Case Size", "Release Detail"):
            red = sum(1 for r in data if fill(r, name) == RED and get(r, name) == MISSING_DETAIL)
            check(red == 120, f"{red} red '{MISSING_DETAIL}' cells in {name}")
        all_red = sum(1 for r in data for v in r.values() if v[1] == RED)
        check(all_red == 360, f"red appears only in those cells ({all_red})")

        check(ws.find(q("autoFilter")).get("ref") == "A1:R121", "autofilter covers A1:R121")
        pane = ws.find(f"{q('sheetViews')}/{q('sheetView')}/{q('pane')}")
        check(pane is not None and pane.get("state") == "frozen", "header row and ID/GID/name columns frozen")
        links = ws.find(q("hyperlinks"))
        link_rels = {r.get("Id"): r.get("Target") for r in parsed["xl/worksheets/_rels/sheet1.xml.rels"].iter(rel_ns)}
        check(all(h.get(f"{{{REL_NS}}}id") in link_rels for h in links), f"{len(links)} hyperlinks resolve to relationships")

        legend_text = " ".join(sst[int(c.find(q("v")).text)] for c in parsed["xl/worksheets/sheet2.xml"].iter(q("c"))
                               if c.get("t") == "s" and c.find(q("v")) is not None)
        for needle in ("Yellow", "Red", "2026-10-14", "not live inventory", "120 data rows", "13 canonical brands",
                       "14 raw source brand strings", "6 rows (4 raw Cannaprint + 2 raw Cannaprints)"):
            check(needle in legend_text, f"Read Me mentions '{needle}'")

    if failures:
        raise SystemExit(f"{len(failures)} check(s) failed.")
    print("All workbook checks passed.")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        raise SystemExit(__doc__)
    if "--verify" in sys.argv:
        verify(*args)
    else:
        build(*args)
