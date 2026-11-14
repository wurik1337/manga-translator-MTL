# MTL — Manga Translator Local

> Локальный переводчик манги и комиксов для браузеров на Chromium (Chrome, Edge, Brave, Opera).
> Всё работает прямо в браузере: нейросети (детекция пузырей + OCR) выполняются на твоём компьютере, ничего устанавливать и настраивать не нужно.
> В сеть уходят только скачивание моделей и текст пузырей — всё распознавание локально.

> Внимание: проект в первую очередь заточен под перевод с английского на русский. С другими языками возможны ошибки.

<p align="center">
  <img width="384" height="599" alt="Внешний вид расширения" src="https://github.com/user-attachments/assets/be69404e-fff7-4a6f-ba4b-1abfe2144021" />
</p>
<p align="center"><sub>Внешний вид расширения</sub></p>

---

## Примеры

<table align="center">
  <tr>
    <td align="center"><img width="420" alt="До" src="https://github.com/user-attachments/assets/41fa8071-4d30-4dff-a7c8-cfe54d46f9e6" /></td>
    <td align="center"><img width="420" alt="После" src="https://github.com/user-attachments/assets/20649df2-7c8d-4e2e-a229-0d6e34548fa2" /></td>
  </tr>
  <tr>
    <td align="center"><img width="380" alt="До" src="https://github.com/user-attachments/assets/8382c103-3d98-4743-b78e-006d32b52246" /></td>
    <td align="center"><img width="380" alt="После" src="https://github.com/user-attachments/assets/51e06ac8-b0ca-4d0c-8054-49ef4a0f1ea3" /></td>
  </tr>
</table>
<p align="center"><sub>Слева — до, справа — после</sub></p>

## Возможности

- Детекция пузырей и текста (RT-DETR) + сменные OCR-движки (PP-OCRv5, PP-OCRv6 Manga, Manga-OCR) — скачиваются прямо из расширения в один клик. При импорте сторонних OCR-моделей возможны ошибки.
- Определение текста и перевод через визуальную LLM (vision LLM): модель сама распознаёт текст на изображении и сразу выдаёт перевод.
- Два движка перевода: Google Translate (бесплатно, без ключей) или своя локальная LLM (подключение только по OpenAI-compatible API).
- Два режима вывода: перекраска пузыря целиком или компактная плашка поверх оригинала.
- Перевод всей страницы, включая длинные вертикальные ленты (webtoon).
- «Загрузить всё и перевести» — для ленивой загрузки: страница автоматически прокручивается, картинки догружаются, позиция возвращается на место.
- Горячие клавиши для «Перевести», «Загрузить всё»: клик по чипу справа от кнопки → назначь сочетание.
- Авто-перевод картинок при появлении на экране.
- Склейка страниц: реплика, разрезанная краем страницы, докрашивается по шву; OCR читает объединённый текст, перевод рисуется на следующей странице (режимы «Стирать текст» / «Рамки», включено по умолчанию).
- «Остановить»: во время «Перевести всю страницу» и «Загрузить всё и перевести» кнопка становится «■ Остановить»; процесс прерывается, при сборе картинок позиция сразу возвращается.
- Экономия памяти на длинных главах: оверлеи рисуются только в окне ±1.6 экрана, чистые пиксели страниц хранятся сжатыми — 100+ переведённых картинок не подвешивают страницу.
- Авто-перевод картинок при появлении на экране.
- Отладка: показать рамки детекции, при наведении на плашку подсмотреть оригинал.
- Тёмный интерфейс, 8 языков (ru / en / es / de / fr / pt / zh / ja).

---

## Установка (2 минуты)

1. Скачай репозиторий (зелёная кнопка Code → Download ZIP), распакуй.
2. Открой `chrome://extensions` (или `edge://extensions`).
3. Включи Режим разработчика (справа сверху).
4. Нажми Загрузить распакованное расширение и укажи папку `manga-translator`.
5. Вкладка Config → у «RT-DETR Lite» и «PP-OCRv6 Manga» нажми круглую иконку загрузки — модели скачаются один раз и сохранятся в кэше браузера.
6. Открой страницу с мангой → вкладка Home → включи «Переводчик» → «Перевести всю страницу».

---

## Локальная LLM (необязательно)

Вместо Google Translate можно подключить свой локальный сервер. Подключение выполняется только по OpenAI-compatible API.

Home → API Mode → вставь адрес → «Проверить соединение» → включи «Переводчик».

| Сервер | Адрес | Команда запуска |
|---|---|---|
| LM Studio | `http://127.0.0.1:1234/v1` | — |
| Ollama | `http://127.0.0.1:11434/v1` | `OLLAMA_ORIGINS=* ollama serve` |
| llama.cpp | `http://127.0.0.1:8080/v1` | — |

---

## Решение проблем

- «Модели не скачаны» / баннер с предупреждением — зайди в Config и нажми кнопку загрузки у детектора (RT-DETR Lite) и у OCR (PP-OCRv5 Mobile), пока обе иконки не станут ярко-зелёными.
- Красная карточка «Фоновый процесс не отвечает» — нажми «Перезапустить расширение» на карточке; если не помогло — `chrome://extensions` → кнопка перезагрузки у MTL.
- Локальные файлы (`file://`) не переводятся — Home → карточка «Локальные файлы (file://)» → «Разрешить доступ» → включи «Разрешить доступ к файлам URLs».
- Пустые плашки / плохое распознавание — попробуй другой OCR (Server точнее, для вертикального японского — Manga-OCR) или поменяй `MIN CONFIDENCE` в Config.
- Ошибки при импорте сторонних OCR — проверь формат файлов модели (ONNX), совместимость с текущей версией расширения и корректность путей; при необходимости используй встроенные OCR-движки из Config.
- Медленно на слабом ПК — возьми лёгкие модели (RT-DETR Lite + PP-OCRv5 Mobile); с WebGPU (Chrome 113+) заметно быстрее.
- Google перестал переводить — редко (лимиты), переключись на API Mode с локальной LLM.

---

## Благодарности

Проект вдохновлён расширением [Libre Manga Translator](https://github.com/Dieschafe/Libre-Manga-Translator) — загляните, если нужна более зрелая альтернатива.

Спасибо авторам моделей:

- Детектор: [ogkalu/comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector)
- OCR: [bukuroo/PPOCRv5-ONNX](https://huggingface.co/bukuroo/PPOCRv5-ONNX), [Kellenok/PP-OCRv6_manga](https://huggingface.co/Kellenok/PP-OCRv6_manga), [mayocream/manga-ocr-onnx](https://huggingface.co/mayocream/manga-ocr-onnx)
- Инференс: [onnxruntime-web](https://github.com/microsoft/onnxruntime)

---

# MTL — Manga Translator Local (English)

> Local manga & comic translator for Chromium browsers (Chrome, Edge, Brave, Opera).
> Everything runs in your browser: the neural networks (bubble detection + OCR) execute on your computer — no servers, no setup.
> Only model downloads and bubble text leave the browser; all recognition is local.

> Note: the project is designed primarily for English → Russian translation. Other language pairs may produce errors.

---

## Features

- Bubble/text detection (RT-DETR) + swappable OCR engines (PP-OCRv5, PP-OCRv6 Manga, Manga-OCR) — downloaded in one click right from the extension. Errors are possible when importing third-party OCR models.
- Text detection and translation via a vision LLM: the model recognizes the text in the image and returns the translation directly.
- Two translation engines: Google Translate (free, no keys) or your own local LLM (connection via OpenAI-compatible API only).
- Two output modes: repaint the whole bubble or a compact overlay box.
- Full-page translation, including long vertical webtoon strips.
- "Load all & translate" for lazy-loaded pages: auto-scrolls, loads images, then restores scroll position.
- Hotkeys for Translate, Load all: click the chip next to a button and press your shortcut.
- Auto-translate images as they appear on screen.
- Page stitching: a speech bubble cut by a page edge is completed along the seam; OCR re-reads the merged text, and the full translation is drawn on the next page (works in Erase text / Boxes modes, enabled by default).
- Stop: during Translate whole page / Load all & translate, the button becomes "■ Stop"; the process stops, and scroll position is restored during image collection.
- Memory savings on long chapters: overlays render only within ±1.6 screens, clean page pixels are stored compressed — 100+ translated images won't freeze the page.
- Auto-translation of images as they appear on screen.
- Debugging: show detection boxes, hover an overlay to peek at the original text.
- Dark UI, 8 languages (ru / en / es / de / fr / pt / zh / ja).

---

## Install (2 minutes)

1. Download the repository (green Code → Download ZIP button) and unpack it.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable Developer mode (top right).
4. Click Load unpacked and select the `manga-translator` folder.
5. Config tab → click the download icon next to "RT-DETR Lite" and "PP-OCRv6 Manga" — models are downloaded once and cached by the browser.
6. Open a manga page → Home tab → enable "Translator" → "Translate the whole page".

---

## Local LLM (optional)

Instead of Google Translate you can use your own local server. Connection is supported via OpenAI-compatible API only.

Home → API Mode → paste the URL → "Check connection" → enable "Translator".

| Server | URL | Startup command |
|---|---|---|
| LM Studio | `http://127.0.0.1:1234/v1` | — |
| Ollama | `http://127.0.0.1:11434/v1` | `OLLAMA_ORIGINS=* ollama serve` |
| llama.cpp | `http://127.0.0.1:8080/v1` | — |

---

## Troubleshooting

- "Models not downloaded" / warning banner — open Config and click the download button next to the detector (RT-DETR Lite) and OCR (PP-OCRv5 Mobile) until both icons turn bright green.
- Red "Background process not responding" card — click "Restart extension" on the card; if that doesn't help, `chrome://extensions` → reload button on MTL.
- Local files (`file://`) don't translate — Home → "Local files (file://)" card → "Allow access" → enable "Allow access to file URLs".
- Empty overlays / poor recognition — try another OCR model (Server is more accurate, Manga-OCR for vertical Japanese) or adjust `MIN CONFIDENCE` in Config.
- Errors when importing third-party OCR — check the model file format (ONNX), compatibility with the current extension version and correct paths; if needed, use the built-in OCR engines from Config.
- Slow on a weak PC — use the light models (RT-DETR Lite + PP-OCRv5 Mobile); WebGPU (Chrome 113+) makes it much faster.
- Google stopped translating — rare (rate limits); switch to API Mode with a local LLM.

---

## Credits

This project was inspired by [Libre Manga Translator](https://github.com/Dieschafe/Libre-Manga-Translator) — check it out if you want a more mature alternative.

Model credits:

- Detector: [ogkalu/comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector)
- OCR: [bukuroo/PPOCRv5-ONNX](https://huggingface.co/bukuroo/PPOCRv5-ONNX), [Kellenok/PP-OCRv6_manga](https://huggingface.co/Kellenok/PP-OCRv6_manga), [mayocream/manga-ocr-onnx](https://huggingface.co/mayocream/manga-ocr-onnx)
- Inference: [onnxruntime-web](https://github.com/microsoft/onnxruntime)
