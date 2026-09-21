import base64, json, math, os, subprocess, sys, tempfile, time, warnings, zipfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

MAX_TEXT = 2_000_000
MAX_IMAGE_PIXELS = 25_000_000
MAX_OCR_PAGE_PIXELS = 10_000_000
MAX_OCR_TOTAL_PIXELS = 60_000_000
MAX_OCR_DIMENSION = 2400
MAX_OCR_PDF_PAGES = 10
OCR_DEADLINE_SECONDS = 25

WINDOWS_OCR = r"""
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Console]::OutputEncoding=[Text.Encoding]::UTF8
function Await($op,[Type]$type){
  $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
  $task=$method.MakeGenericMethod($type).Invoke($null,@($op))
  $task.GetAwaiter().GetResult()
}
$stream=$null; $file=$null; $bitmap=$null
try {
  $path=[Environment]::GetEnvironmentVariable('PULT_OCR_IMAGE')
  $file=[IO.File]::OpenRead($path)
  $stream=[System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($file)
  $decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $language=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]::new('ru')
  $engine=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]::TryCreateFromLanguage($language)
  if($null -eq $engine){ throw 'Russian Windows OCR is unavailable' }
  $result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $result.Lines | ForEach-Object { $_.Text }
} finally {
  if($null -ne $bitmap){$bitmap.Dispose()}
  if($null -ne $stream){$stream.Dispose()}
  if($null -ne $file){$file.Dispose()}
}
"""

def fail(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    raise SystemExit(2)

def _pil():
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    return Image

def _safe_image(path):
    Image = _pil()
    try:
        with Image.open(path) as value:
            width, height = value.size
            frames = getattr(value, "n_frames", 1)
            if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS or frames != 1:
                fail("Изображение превышает безопасный размер или содержит несколько кадров.")
            value.verify()
        with Image.open(path) as value:
            value.load()
            return value.convert("RGB")
    except SystemExit:
        raise
    except Exception:
        fail("Изображение повреждено или использует неподдерживаемую структуру.")

def _windows_ocr(value, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return None, "Превышено время локального OCR; текст скана не распознан полностью."
    width, height = value.size
    scale = min(1.0, MAX_OCR_DIMENSION / max(width, height))
    if scale < 1.0:
        value = value.resize((max(1, round(width * scale)), max(1, round(height * scale))))
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as target:
            temporary = target.name
        value.save(temporary, format="PNG", optimize=False)
        encoded = base64.b64encode(WINDOWS_OCR.encode("utf-16le")).decode("ascii")
        env = os.environ.copy()
        env["PULT_OCR_IMAGE"] = temporary
        completed = subprocess.run(
            ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
            capture_output=True, timeout=max(1, min(6, remaining)), env=env, check=False
        )
        if completed.returncode != 0:
            return None, "Встроенный локальный OCR Windows недоступен; текст скана не распознан."
        text = completed.stdout.decode("utf-8", errors="replace").lstrip("\ufeff").strip()
        return text, None
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return None, "Встроенный локальный OCR Windows недоступен; текст скана не распознан."
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass

def _ocr_images(images):
    deadline = time.monotonic() + OCR_DEADLINE_SECONDS
    pages, notices = [], []
    for page_number, value in images:
        text, notice = _windows_ocr(value, deadline)
        pages.append({"page": page_number, "text": text or ""})
        if notice and notice not in notices:
            notices.append(notice)
    if any(page["text"] for page in pages):
        notices.insert(0, "Текст распознан встроенным локальным OCR Windows (русский); это черновик, сверьте поля с оригиналом.")
    elif not notices:
        notices.append("Локальный OCR выполнен, но текст на скане не распознан.")
    return {"pages": pages, "warnings": notices}

def _ocr_pdf(path, page_count):
    if page_count > MAX_OCR_PDF_PAGES:
        fail("В PDF без текстового слоя больше 10 страниц; локальный OCR ограничен первичной безопасной проверкой.")
    try:
        import pypdfium2 as pdfium
        document = pdfium.PdfDocument(path)
        images, total_pixels = [], 0
        try:
            for index in range(page_count):
                page = document[index]
                width, height = page.get_size()
                scale = min(2.0, math.sqrt(MAX_OCR_PAGE_PIXELS / max(1, width * height)))
                pixels = math.ceil(width * scale) * math.ceil(height * scale)
                total_pixels += pixels
                if pixels > MAX_OCR_PAGE_PIXELS or total_pixels > MAX_OCR_TOTAL_PIXELS:
                    fail("Растеризация PDF превышает безопасный лимит пикселей.")
                bitmap = page.render(scale=scale, grayscale=True)
                try:
                    images.append((index + 1, bitmap.to_pil().convert("RGB")))
                finally:
                    bitmap.close()
                    page.close()
        finally:
            document.close()
        return _ocr_images(images)
    except SystemExit:
        raise
    except (ImportError, OSError, RuntimeError, ValueError):
        return {"pages": [{"page": index, "text": ""} for index in range(1, page_count + 1)], "warnings": ["Локальная растеризация PDF недоступна; текст скана не распознан."]}

def pdf(path):
    from pypdf import PdfReader
    try:
        reader = PdfReader(path, strict=True)
        if reader.is_encrypted:
            fail("PDF защищён паролем; локальное извлечение невозможно.")
        if len(reader.pages) > 200:
            fail("В PDF больше 200 страниц.")
        pages, total = [], 0
        for index, page in enumerate(reader.pages, 1):
            text = page.extract_text() or ""
            total += len(text)
            if total > MAX_TEXT:
                fail("Текст документа превышает безопасный лимит.")
            pages.append({"page": index, "text": text})
        return {"pages": pages, "warnings": []} if any(p["text"].strip() for p in pages) else _ocr_pdf(path, len(pages))
    except SystemExit:
        raise
    except Exception:
        fail("PDF повреждён или использует неподдерживаемую структуру.")

def docx(path):
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > 2000:
                fail("В DOCX слишком много вложенных файлов.")
            total = sum(i.file_size for i in infos)
            if total > 80 * 1024 * 1024 or any(i.file_size > 25 * 1024 * 1024 for i in infos):
                fail("Распакованный DOCX превышает безопасный лимит.")
            if any(i.flag_bits & 1 for i in infos):
                fail("Зашифрованный DOCX не поддерживается.")
            if any(i.file_size > 1_000_000 and i.compress_size and i.file_size / i.compress_size > 300 for i in infos):
                fail("DOCX имеет опасную степень сжатия.")
            names = {i.filename for i in infos}
            if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                fail("Файл ZIP не является документом DOCX.")
            notices = []
            if any("vbaProject" in name or name.startswith("word/embeddings/") for name in names):
                notices.append("Макросы и встроенные объекты обнаружены и проигнорированы.")
            relationships = [name for name in names if name.endswith(".rels")]
            if any(b'TargetMode="External"' in archive.read(name) for name in relationships):
                notices.append("Внешние ссылки обнаружены и не открывались.")
            from xml.etree import ElementTree
            root = ElementTree.fromstring(archive.read("word/document.xml"))
            ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
            paragraphs = []
            for paragraph in root.iter(ns + "p"):
                value = "".join(node.text or "" for node in paragraph.iter(ns + "t")).strip()
                if value:
                    paragraphs.append(value)
            text = "\n".join(paragraphs)
            if len(text) > MAX_TEXT:
                fail("Текст документа превышает безопасный лимит.")
            return {"pages": [{"page": None, "text": text}], "warnings": notices}
    except SystemExit:
        raise
    except (zipfile.BadZipFile, KeyError, ValueError):
        fail("DOCX повреждён или использует неподдерживаемую структуру.")

def image(path):
    return _ocr_images([(1, _safe_image(path))])

if len(sys.argv) != 3:
    fail("Некорректный запуск извлечения.")
kind, source = sys.argv[1:]
result = pdf(source) if kind == "pdf" else docx(source) if kind == "docx" else image(source) if kind in ("png", "jpg") else fail("Формат не поддерживается.")
result["ok"] = True
print(json.dumps(result, ensure_ascii=False))
