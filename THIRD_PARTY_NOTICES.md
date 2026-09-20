# Third-Party Notices

This distribution includes the following third-party components for local file parsing, OCR, and local model inference. No component is loaded from a remote URL at runtime.

## ONNX Runtime Web 1.29.0

Copyright (c) Microsoft Corporation.

Licensed under the MIT License. This distribution bundles `onnxruntime-web` and its WASM binaries for local inference. Source and full license: https://github.com/microsoft/onnxruntime

## Chinese ELECTRA Small Discriminator Base Model

The bundled R9 local PII student (`r9-electra-chat-augmented/checkpoint-3798`, runtime threshold `0.15`) is fine-tuned from `hfl/chinese-electra-small-discriminator`, licensed under Apache License, Version 2.0. Model source: https://huggingface.co/hfl/chinese-electra-small-discriminator

## JSZip 3.10.1

Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, and Antonio Afonso.

This distribution uses the MIT option of JSZip's dual MIT/GPL-3.0-or-later license. The MIT license permits use, copying, modification, distribution, sublicensing, and sale when this copyright notice and permission notice are included. The software is provided without warranty. Source and full license: https://github.com/Stuk/jszip

## PDF.js 6.2.108

Copyright 2024 Mozilla Foundation.

Licensed under the Apache License, Version 2.0. You may obtain a copy of the license at https://www.apache.org/licenses/LICENSE-2.0. Source: https://github.com/mozilla/pdf.js

## Tesseract.js 7.0.0 and tesseract.js-core 7.0.0

Copyright 2018-2026 Tesseract.js contributors.

Licensed under the Apache License, Version 2.0. You may obtain a copy of the license at https://www.apache.org/licenses/LICENSE-2.0. Sources: https://github.com/naptha/tesseract.js and https://github.com/naptha/tesseract.js-core

## Tesseract tessdata_fast Language Data

The bundled `chi_sim.traineddata` and `eng.traineddata` files are from the Apache-2.0 licensed `tesseract-ocr/tessdata_fast` project: https://github.com/tesseract-ocr/tessdata_fast

- `chi_sim.traineddata` SHA-256: `A5FCB6F0DB1E1D6D8522F39DB4E848F05984669172E584E8D76B6B3141E1F730`
- `eng.traineddata` SHA-256: `7D4322BD2A7749724879683FC3912CB542F19906C83BCC1A52132556427170B2`

Apache License, Version 2.0 components are provided on an "AS IS" basis, without warranties or conditions of any kind. See the license URL above for the complete terms.
