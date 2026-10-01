"""Bounded, read-only extraction of cells from an Ozon XLSX report. No formulas run."""
import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation

MAX_INPUT = 8 * 1024 * 1024
MAX_EXPANDED = 48 * 1024 * 1024
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

def xml(data):
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('XML entities are not supported')
    return ET.fromstring(data)

def read(data):
    if len(data) > MAX_INPUT:
        raise ValueError('File too large')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(v.file_size for v in entries) > MAX_EXPANDED:
            raise ValueError('Archive too large')
        names = [v.filename for v in entries]
        if len(set(names)) != len(names):
            raise ValueError('Duplicate archive entry')
        strings = []
        if 'xl/sharedStrings.xml' in names:
            strings = [''.join(t.text or '' for t in item.findall('.//s:t', NS)) for item in xml(archive.read('xl/sharedStrings.xml')).findall('s:si', NS)]
        percentage_styles = set()
        if 'xl/styles.xml' in names:
            styles = xml(archive.read('xl/styles.xml'))
            formats = {int(item.get('numFmtId', '0')): item.get('formatCode', '') for item in styles.findall('s:numFmts/s:numFmt', NS)}
            for index, item in enumerate(styles.findall('s:cellXfs/s:xf', NS)):
                code = int(item.get('numFmtId', '0'))
                fmt = re.sub(r'"[^"]*"|\\.|_.|\*.', '', formats.get(code, ''))
                if code in (9, 10) or '%' in fmt:
                    percentage_styles.add(index)
        sheets = []
        total = 0
        for name in sorted(names):
            if not re.fullmatch(r'xl/worksheets/sheet\d+\.xml', name):
                continue
            rows = []
            for row in xml(archive.read(name)).findall('.//s:sheetData/s:row', NS):
                values = []
                for cell in row.findall('s:c', NS):
                    match = re.match(r'([A-Z]{1,3})[1-9][0-9]*$', cell.get('r', ''))
                    if not match:
                        raise ValueError('Cell coordinate is missing')
                    column = 0
                    for char in match[1]:
                        column = column * 26 + ord(char) - 64
                    if column > 128:
                        raise ValueError('Too many columns')
                    while len(values) < column:
                        values.append('')
                    value = cell.find('s:v', NS)
                    text = value.text or '' if value is not None else ''
                    if cell.get('t') == 's':
                        text = strings[int(text)]
                    elif cell.get('t') == 'inlineStr':
                        text = ''.join(t.text or '' for t in cell.findall('.//s:t', NS))
                    elif cell.get('t', 'n') == 'n' and int(cell.get('s', '0')) in percentage_styles and text:
                        try:
                            text = format(Decimal(text) * 100, 'f')
                        except InvalidOperation:
                            raise ValueError('Invalid percentage')
                    if cell.find('s:f', NS) is not None:
                        text = ''  # Cached formula values are not imported as observed facts.
                    if len(text) > 12000:
                        raise ValueError('Cell too large')
                    values[column - 1] = text
                rows.append(values)
                total += 1
                if total > 10020:
                    raise ValueError('Too many rows')
            sheets.append(rows)
        if not sheets:
            raise ValueError('No worksheet found')
        return sheets

if __name__ == '__main__':
    try:
        result = {'ok': True, 'sheets': read(sys.stdin.buffer.read(MAX_INPUT + 1))}
    except Exception:
        result = {'ok': False, 'error': 'REPORT_INVALID'}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))
