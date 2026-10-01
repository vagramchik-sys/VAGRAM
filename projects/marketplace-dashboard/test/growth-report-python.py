import importlib.util
import io
import pathlib
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('reader', pathlib.Path(__file__).parents[1] / 'scripts' / 'growth-report-read.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

def archive(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as z:
        for key, value in entries.items():
            z.writestr(key, value)
    return stream.getvalue()

class Tests(unittest.TestCase):
    def test_percentage_and_formula(self):
        data = archive({
            'xl/styles.xml': f'<styleSheet xmlns="{NS}"><cellXfs><xf numFmtId="0"/><xf numFmtId="10"/></cellXfs></styleSheet>',
            'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{NS}"><sheetData><row r="1"><c r="A1" s="1"><v>0.15</v></c><c r="B1"><v>14.7</v></c><c r="C1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>'
        })
        self.assertEqual(reader.read(data), [[['15.00', '14.7', '']]])

    def test_no_entity_evaluation(self):
        with self.assertRaises(ValueError):
            reader.read(archive({'xl/worksheets/sheet1.xml': '<!DOCTYPE foo [<!ENTITY x "test">]><foo>&x;</foo>'}))

    def test_sparse_columns_and_inline_strings(self):
        data = archive({'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{NS}"><sheetData><row r="1"><c r="C1" t="inlineStr"><is><t>Название</t></is></c></row></sheetData></worksheet>'})
        self.assertEqual(reader.read(data), [[['', '', 'Название']]])

if __name__ == '__main__':
    unittest.main()
