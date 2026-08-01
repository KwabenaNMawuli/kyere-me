(function () {
  'use strict';

  const STORAGE_KEY = 'kyereme_gemini_api_key';
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  const MAX_TEXT_CHARS = 600000; // safety margin within the model's context window
  const GEMINI_MODEL = 'gemini-3.6-flash';
  const MIN_QUESTIONS = 1;
  const MAX_QUESTIONS = 500;
  const BATCH_SIZE = 25; // questions per API call; keeps each response well under the output token ceiling
  const BATCH_DELAY_MS = 4300; // paces sequential calls under Gemini free-tier's 15 requests/minute
  const SCORE_RING_CIRCUMFERENCE = 326.7; // 2 * PI * r(52), matches css stroke-dasharray

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  // ---------- DOM refs ----------
  const screens = {
    upload: document.getElementById('screen-upload'),
    loading: document.getElementById('screen-loading'),
    error: document.getElementById('screen-error'),
    quiz: document.getElementById('screen-quiz'),
    results: document.getElementById('screen-results'),
  };

  const apiKeyBtn = document.getElementById('api-key-btn');
  const apiKeyBtnLabel = document.getElementById('api-key-btn-label');
  const apiKeyBanner = document.getElementById('api-key-banner');
  const apiKeyModal = document.getElementById('api-key-modal');
  const apiKeyModalClose = document.getElementById('api-key-modal-close');
  const apiKeyInput = document.getElementById('api-key-input');
  const apiKeyToggle = document.getElementById('api-key-toggle');
  const apiKeySaveBtn = document.getElementById('api-key-save-btn');
  const apiKeyClearBtn = document.getElementById('api-key-clear-btn');
  const apiKeyErrorEl = document.getElementById('api-key-error');

  const uploadForm = document.getElementById('upload-form');
  const dropzone = document.getElementById('dropzone');
  const pdfInput = document.getElementById('pdf-input');
  const fileChip = document.getElementById('file-chip');
  const fileChipName = document.getElementById('file-chip-name');
  const fileChipSize = document.getElementById('file-chip-size');
  const fileChipRemove = document.getElementById('file-chip-remove');
  const fileErrorEl = document.getElementById('file-error');
  const generateBtn = document.getElementById('generate-btn');
  const qcountInput = document.getElementById('qcount-input');
  const qcountChips = Array.from(document.querySelectorAll('.qcount-chip'));

  const stepRead = document.getElementById('step-read');
  const stepGenerate = document.getElementById('step-generate');
  const generateProgressText = document.getElementById('generate-progress-text');
  const cancelBtn = document.getElementById('cancel-btn');

  const errorMessageEl = document.getElementById('error-message');
  const errorRetryBtn = document.getElementById('error-retry-btn');

  const quizProgressFill = document.getElementById('quiz-progress-fill');
  const quizProgressbar = document.getElementById('quiz-progressbar');
  const quizPosition = document.getElementById('quiz-position');
  const questionText = document.getElementById('question-text');
  const optionsList = document.getElementById('options-list');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const submitBtn = document.getElementById('submit-btn');

  const scoreRingFill = document.getElementById('score-ring-fill');
  const scorePercent = document.getElementById('score-percent');
  const scoreText = document.getElementById('score-text');
  const restartBtn = document.getElementById('restart-btn');
  const reviewList = document.getElementById('review-list');

  // ---------- State ----------
  let selectedFile = null;
  let quizData = [];
  let userAnswers = [];
  let currentIndex = 0;
  let abortController = null;

  // ---------- API key ----------
  function getApiKey() {
    return localStorage.getItem(STORAGE_KEY) || '';
  }
  function setApiKey(key) {
    localStorage.setItem(STORAGE_KEY, key);
  }
  function clearApiKey() {
    localStorage.removeItem(STORAGE_KEY);
  }
  function refreshApiKeyUI() {
    const has = !!getApiKey();
    apiKeyBtnLabel.textContent = has ? 'API key added' : 'Add API key';
    apiKeyBanner.hidden = has;
    updateGenerateButtonState();
  }

  function openApiKeyModal() {
    apiKeyInput.value = getApiKey();
    apiKeyErrorEl.hidden = true;
    apiKeyModal.hidden = false;
    document.body.style.overflow = 'hidden';
    apiKeyInput.focus();
  }
  function closeApiKeyModal() {
    apiKeyModal.hidden = true;
    document.body.style.overflow = '';
    apiKeyBtn.focus();
  }

  apiKeyBtn.addEventListener('click', openApiKeyModal);
  document.querySelectorAll('[data-open-api-modal]').forEach((btn) => btn.addEventListener('click', openApiKeyModal));
  apiKeyModalClose.addEventListener('click', closeApiKeyModal);
  apiKeyModal.addEventListener('click', (e) => { if (e.target === apiKeyModal) closeApiKeyModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !apiKeyModal.hidden) closeApiKeyModal();
  });

  apiKeyToggle.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    apiKeyToggle.setAttribute('aria-label', isPassword ? 'Hide API key' : 'Show API key');
  });

  apiKeySaveBtn.addEventListener('click', () => {
    const value = apiKeyInput.value.trim();
    if (!value) {
      apiKeyErrorEl.textContent = 'Please enter an API key.';
      apiKeyErrorEl.hidden = false;
      return;
    }
    setApiKey(value);
    refreshApiKeyUI();
    closeApiKeyModal();
  });

  apiKeyClearBtn.addEventListener('click', () => {
    clearApiKey();
    apiKeyInput.value = '';
    refreshApiKeyUI();
  });

  // ---------- Screen management ----------
  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el.hidden = key !== name;
    });
    const heading = screens[name].querySelector('h1, h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- File handling ----------
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function setFileError(msg) {
    if (!msg) { fileErrorEl.hidden = true; fileErrorEl.textContent = ''; return; }
    fileErrorEl.hidden = false;
    fileErrorEl.textContent = msg;
  }

  function selectFile(file) {
    setFileError('');
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      setFileError('Please choose a PDF file.');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setFileError('File is too large. Max size is 10MB.');
      return;
    }
    selectedFile = file;
    fileChipName.textContent = file.name;
    fileChipSize.textContent = formatBytes(file.size);
    fileChip.hidden = false;
    dropzone.hidden = true;
    updateGenerateButtonState();
  }

  function clearFile() {
    selectedFile = null;
    pdfInput.value = '';
    fileChip.hidden = true;
    dropzone.hidden = false;
    setFileError('');
    updateGenerateButtonState();
  }

  function updateGenerateButtonState() {
    generateBtn.disabled = !selectedFile || !getApiKey();
  }

  pdfInput.addEventListener('change', (e) => selectFile(e.target.files[0]));
  fileChipRemove.addEventListener('click', clearFile);

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) selectFile(file);
  });

  // ---------- Question count ----------
  function getQuestionCount() {
    const n = Math.round(Number(qcountInput.value));
    if (!Number.isFinite(n)) return 10;
    return Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, n));
  }

  function syncActiveChip() {
    const current = String(getQuestionCount());
    qcountChips.forEach((chip) => chip.classList.toggle('is-active', chip.dataset.qcount === current));
  }

  qcountChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      qcountInput.value = chip.dataset.qcount;
      syncActiveChip();
    });
  });
  qcountInput.addEventListener('input', syncActiveChip);
  qcountInput.addEventListener('blur', () => {
    qcountInput.value = String(getQuestionCount());
    syncActiveChip();
  });

  // ---------- PDF text extraction ----------
  async function extractTextFromPDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str).join(' ');
      fullText += pageText + '\n\n';
    }
    return fullText.trim();
  }

  // ---------- Gemini API ----------
  const QUIZ_SCHEMA = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        question: { type: 'STRING' },
        options: { type: 'ARRAY', items: { type: 'STRING' } },
        correctAnswer: { type: 'STRING' },
        explanation: { type: 'STRING' },
      },
      required: ['question', 'options', 'correctAnswer', 'explanation'],
    },
  };

  function buildPrompt(text, count, priorQuestions) {
    const lines = [
      `You are an expert quiz writer. Based ONLY on the study material below, write exactly ${count} multiple-choice questions that test understanding of the key concepts.`,
      '',
      'Rules:',
      '- Each question must have exactly 4 answer options.',
      '- Exactly one option is correct.',
      '- "correctAnswer" must be an exact copy of one of the strings in "options".',
      '- Only use facts stated in the material; do not invent information.',
      '- Vary difficulty and avoid trivial copy-paste wording.',
      '- "explanation" briefly justifies the correct answer using the material.',
      '- Respond with ONLY the JSON array. No markdown, no extra commentary.',
    ];
    if (priorQuestions && priorQuestions.length) {
      lines.push(
        '',
        'These questions have already been used in this quiz — do not repeat them or ask close variations of them:',
        ...priorQuestions.map((q) => `- ${q}`),
      );
    }
    lines.push('', 'STUDY MATERIAL:', '"""', text, '"""');
    return lines.join('\n');
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }
    });
  }

  async function generateQuizBatch(text, count, priorQuestions, signal) {
    const apiKey = getApiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [{ parts: [{ text: buildPrompt(text, count, priorQuestions) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: QUIZ_SCHEMA,
      },
    };

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new Error('Could not reach the Gemini API. Check your internet connection and try again.');
    }

    if (!response.ok) {
      if (response.status === 400 || response.status === 403) {
        throw new Error('Your API key was rejected. Double-check it in Google AI Studio and try again.');
      }
      if (response.status === 429) {
        throw new Error('Gemini’s free tier rate limit was hit (15 requests/minute). Wait about a minute and try again.');
      }
      throw new Error(`Gemini API error (status ${response.status}). Please try again.`);
    }

    const data = await response.json();
    const candidate = data && data.candidates && data.candidates[0];
    const rawText = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;

    if (!rawText) {
      if (candidate && candidate.finishReason === 'SAFETY') {
        throw new Error('The AI declined to process this document. Try a different PDF.');
      }
      throw new Error('The AI returned an empty response. Please try again.');
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      throw new Error('The AI response could not be understood. Please try again.');
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('The AI did not return any questions. Try a document with more text content.');
    }

    const cleaned = parsed
      .filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length >= 2 && typeof q.correctAnswer === 'string')
      .map((q) => ({
        question: q.question,
        options: q.options,
        correctAnswer: q.correctAnswer,
        explanation: typeof q.explanation === 'string' ? q.explanation : '',
      }));

    if (cleaned.length === 0) {
      throw new Error('The AI response was not in the expected format. Please try again.');
    }

    return cleaned;
  }

  async function generateFullQuiz(text, totalCount, signal, onProgress) {
    const results = [];
    const seen = new Set();
    const batchCount = Math.ceil(totalCount / BATCH_SIZE);
    let lastError = null;

    for (let i = 0; i < batchCount; i++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const remaining = totalCount - results.length;
      if (remaining <= 0) break;
      const thisBatchSize = Math.min(BATCH_SIZE, remaining);

      onProgress({ batchNumber: i + 1, totalBatches: batchCount, generated: results.length, total: totalCount });

      try {
        const priorQuestions = results.map((q) => q.question);
        const batch = await generateQuizBatch(text, thisBatchSize, priorQuestions, signal);
        for (const q of batch) {
          const key = q.question.trim().toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            results.push(q);
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = err;
        break;
      }

      if (i < batchCount - 1 && results.length < totalCount) {
        onProgress({ batchNumber: i + 1, totalBatches: batchCount, generated: results.length, total: totalCount, waiting: true });
        await sleep(BATCH_DELAY_MS, signal);
      }
    }

    if (results.length === 0) {
      throw lastError || new Error('No questions could be generated. Please try again.');
    }

    return results;
  }

  // ---------- Loading steps ----------
  function setStepState(step, state) {
    step.classList.remove('active', 'done');
    if (state) step.classList.add(state);
  }

  // ---------- Main generate flow ----------
  async function handleGenerate(e) {
    e.preventDefault();
    if (!selectedFile) { setFileError('Please choose a PDF file.'); return; }
    if (!getApiKey()) { openApiKeyModal(); return; }

    const count = getQuestionCount();

    abortController = new AbortController();
    showScreen('loading');
    setStepState(stepRead, 'active');
    setStepState(stepGenerate, null);
    generateProgressText.hidden = true;

    try {
      const text = await extractTextFromPDF(selectedFile);
      if (!text || text.replace(/\s/g, '').length < 40) {
        throw new Error('Could not extract text. Please ensure the PDF is a text document, not a scanned image.');
      }

      setStepState(stepRead, 'done');
      setStepState(stepGenerate, 'active');

      const truncated = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
      const quiz = await generateFullQuiz(truncated, count, abortController.signal, updateGenerateProgress);

      setStepState(stepGenerate, 'done');
      startQuiz(quiz);
    } catch (err) {
      if (err.name === 'AbortError') {
        showScreen('upload');
        return;
      }
      showError(err.message || 'Something went wrong. Please try again.');
    }
  }

  function updateGenerateProgress({ batchNumber, totalBatches, generated, total, waiting }) {
    if (totalBatches <= 1) { generateProgressText.hidden = true; return; }
    generateProgressText.hidden = false;
    generateProgressText.textContent = waiting
      ? `${generated} of ${total} generated so far — pacing requests to stay within the API's rate limit…`
      : `Batch ${batchNumber} of ${totalBatches} — ${generated} of ${total} questions generated so far`;
  }

  function showError(message) {
    errorMessageEl.textContent = message;
    showScreen('error');
  }

  cancelBtn.addEventListener('click', () => {
    if (abortController) abortController.abort();
  });
  errorRetryBtn.addEventListener('click', () => showScreen('upload'));
  uploadForm.addEventListener('submit', handleGenerate);

  // ---------- Quiz screen ----------
  function startQuiz(quiz) {
    quizData = quiz;
    userAnswers = new Array(quiz.length).fill(null);
    currentIndex = 0;
    showScreen('quiz');
    renderQuestion();
  }

  function renderQuestion() {
    const total = quizData.length;
    const q = quizData[currentIndex];
    const pct = Math.round(((currentIndex + 1) / total) * 100);
    quizProgressFill.style.width = pct + '%';
    quizProgressbar.setAttribute('aria-valuenow', String(pct));
    quizPosition.textContent = `Question ${currentIndex + 1} of ${total}`;

    questionText.textContent = q.question;
    optionsList.innerHTML = '';

    q.options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option';
      const isSelected = userAnswers[currentIndex] === opt;
      btn.setAttribute('aria-pressed', String(isSelected));
      if (isSelected) btn.classList.add('selected');
      const marker = document.createElement('span');
      marker.className = 'option-marker';
      marker.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = opt;
      btn.append(marker, label);
      btn.addEventListener('click', () => {
        userAnswers[currentIndex] = opt;
        renderQuestion();
      });
      optionsList.appendChild(btn);
    });

    prevBtn.disabled = currentIndex === 0;
    const isLast = currentIndex === total - 1;
    nextBtn.hidden = isLast;
    submitBtn.hidden = !isLast;
  }

  prevBtn.addEventListener('click', () => {
    if (currentIndex > 0) { currentIndex--; renderQuestion(); }
  });
  nextBtn.addEventListener('click', () => {
    if (currentIndex < quizData.length - 1) { currentIndex++; renderQuestion(); }
  });
  submitBtn.addEventListener('click', () => showResults());

  // ---------- Results ----------
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function checkIcon() {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  function crossIcon() {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  }

  function showResults() {
    const total = quizData.length;
    let correct = 0;
    quizData.forEach((q, i) => { if (userAnswers[i] === q.correctAnswer) correct++; });
    const pct = Math.round((correct / total) * 100);

    const offset = SCORE_RING_CIRCUMFERENCE - (SCORE_RING_CIRCUMFERENCE * pct) / 100;
    scoreRingFill.style.strokeDashoffset = String(offset);
    scorePercent.textContent = pct + '%';
    scoreText.textContent = `You scored ${correct} out of ${total} correct.`;

    reviewList.innerHTML = '';
    quizData.forEach((q, i) => {
      const userAnswer = userAnswers[i];
      const isCorrect = userAnswer === q.correctAnswer;
      const li = document.createElement('li');
      li.className = 'review-item ' + (isCorrect ? 'is-correct' : 'is-incorrect');
      li.innerHTML = `
        <div class="review-item-header">
          <span class="review-badge" aria-hidden="true">${isCorrect ? checkIcon() : crossIcon()}</span>
          <p class="review-question">${i + 1}. ${escapeHtml(q.question)}</p>
        </div>
        <div class="review-answer-row"><span class="label">Your answer</span><span class="value ${isCorrect ? 'correct' : 'incorrect'}">${escapeHtml(userAnswer || 'No answer')}</span></div>
        ${isCorrect ? '' : `<div class="review-answer-row"><span class="label">Correct answer</span><span class="value correct">${escapeHtml(q.correctAnswer)}</span></div>`}
        ${q.explanation ? `<p class="review-explanation">${escapeHtml(q.explanation)}</p>` : ''}
      `;
      reviewList.appendChild(li);
    });

    showScreen('results');
  }

  restartBtn.addEventListener('click', () => {
    clearFile();
    quizData = [];
    userAnswers = [];
    currentIndex = 0;
    showScreen('upload');
  });

  // ---------- Init ----------
  refreshApiKeyUI();
  syncActiveChip();
})();
