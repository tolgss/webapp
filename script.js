// Text to speech API: sk_7faf124d4796e1bab67c14ac0fd1abfe2bd10180400d2ccf
/**
 * Rebuilds the tag‐filter UI and updates selectedTags to match.
 */
function showTagFilters() {
  const container = document.getElementById("tagCheckboxes");
  container.innerHTML = "";

  // 1) Gather every tag from data
  const allTags = new Set();
  data.forEach(card => {
    normalizeTags(card.tag).forEach(t => allTags.add(t));
  });

  // 2) Always include "no-tag" first, then the sorted tags
  const tagsList = ["no-tag", ...Array.from(allTags).sort()];

  // 3) Save for card-tag rendering (exclude "no-tag")
  availableTags = Array.from(allTags);

  // 4) Build each checkbox, pre-checking if in selectedTags
  tagsList.forEach(tag => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = tag;
    if (selectedTags.includes(tag)) {
      input.checked = true;
    }
    label.appendChild(input);
    label.appendChild(document.createTextNode(` ${tag}`));
    container.appendChild(label);
  });

  // 5) Reveal the import-screen controls (filters & buttons)
  document.getElementById("tagFilterContainer").style.display = "block";
  document.getElementById("startStudyBtn").style.display = "inline-block";
  document.getElementById("startReviewBtn").style.display = "inline-block";
  document.getElementById("exportBtn").style.display = "inline-block";

  // 6) Reveal the Add-Card + count controls now that data exists
  document.getElementById("importControls").style.display = "flex";

  // 7) Sync the “All Tags” master checkbox
  const boxes = Array.from(
    document.querySelectorAll("#tagCheckboxes input[type='checkbox']")
  );
  const selectAll = document.getElementById("selectAllTags");
  selectAll.checked =
    boxes.length > 0 && boxes.every(b => b.checked);

  // 8) Update selectedTags to exactly what’s checked now
  selectedTags = boxes
    .filter(b => b.checked)
    .map(b => b.value);
}




// === Persistence Layer: IndexedDB Helpers ===
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("QAReviewApp", 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("qaStore")) {
        db.createObjectStore("qaStore");
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function saveQAData(data) {
  const db = await openDB();
  const tx = db.transaction("qaStore", "readwrite");
  tx.objectStore("qaStore").put(data, "qaData");
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// === Global State ===
let data = [];
let currentFileName = "";
let filteredData = [];
let currentIndex = 0;
let lotIndex = 1;
const LOT_SIZE = 100;

let autoModeActive = false;
let studyInterval = null;
let currentTimer = 2;
let darknessThreshold = 20;
const REQUIRED_DARK_FRAMES = 5;
let lightDetected = false;
let cameraStream = null;
let detectionInterval = null;
let isInReviewMode = false;
let isInStudyMode = false;
let availableTags = [];
let selectedTags = [];
let newCardSelectedTags = [];
let reviewSessionTags = [];
let audioEnabled = false;

// Tracks whether we should auto-advance via audio (🔊) or timer
let autoReviewTimeout = null;
//let currentAudio = null;
let audioCtx = null;





let reviewPool = [];     // indices of cards yet to batch
let reviewedCount = 0;      // total committed
const BATCH_SIZE = 20;     // batch size
let currentBatch = [];     // indices of cards in this batch
let batchIndex = 0;      // pointer within currentBatch

// ——— Draw a random batch of up to BATCH_SIZE cards ———
function drawBatch() {
  // on the very first call, fill the pool
  if (reviewPool.length === 0) {
    reviewPool = filteredData.map((_, i) => i);
    reviewedCount = 0;
  }

  // pick up to BATCH_SIZE random indices out of reviewPool
  currentBatch = [];
  for (let i = 0; i < BATCH_SIZE && reviewPool.length; i++) {
    const pick = Math.floor(Math.random() * reviewPool.length);
    currentBatch.push(reviewPool.splice(pick, 1)[0]);
  }
  batchIndex = 0;

  updateProgressBar();
  reviewShowCard();
}

/**
 * Rebuilds the progress bar showing:
 * - reviewedCount and % done in green
 * - in-progress count in purple
 * - remaining count and % remaining in gray
 */
function updateProgressBar() {
  const total = filteredData.length;
  const inProg = currentBatch.length;
  const reviewed = reviewedCount;
  const remaining = total - reviewed - inProg;

  const pctDone = total > 0 ? Math.round((reviewed / total) * 100) : 0;
  const pctRemain = total > 0 ? Math.round((remaining / total) * 100) : 0;

  const bar = document.getElementById('reviewProgressBar');
  bar.innerHTML = `
    <div class="reviewed"    style="flex:${reviewed}">
      ${reviewed} (${pctDone}%)
    </div>
    <div class="in-progress" style="flex:${inProg}">
      ${inProg}
    </div>
    <div class="remaining"   style="flex:${remaining}">
      ${remaining} (${pctRemain}%)
    </div>
  `;
}



/**
 * When all cards are reviewed:
 * - Hide the card content, tags, favourite star
 * - Hide the Finish & Reset buttons
 * - Hide all bottom-menu items except Exit
 * - Show a single “You have reviewed all cards” label
 */
function showCompletion() {
  // hide card visuals
  document.getElementById("reviewFavouriteStar").style.display = "none";
  document.getElementById("reviewContent").style.display = "none";
  document.getElementById("reviewCardTags").style.display = "none";
  document.getElementById("reviewDetectionStatus").style.display = "none";

  // hide header buttons
  document.getElementById("finishBatchBtn").style.display = "none";
  document.getElementById("resetReviewBtn").style.display = "none";

  // bottom-menu: only keep the Exit button
  document.querySelectorAll("#reviewModal .bottom-menu .menu-item")
    .forEach(item => {
      if (!item.querySelector(".close-btn")) {
        item.style.display = "none";
      }
    });

  // inject completion message (once)
  if (!document.getElementById("reviewCompletionMsg")) {
    const msg = document.createElement("div");
    msg.id = "reviewCompletionMsg";
    msg.textContent = "You have reviewed all cards";
    msg.style.cssText = `
      text-align: center;
      color: #fff;
      font-size: 1.5rem;
      margin-top: 2rem;
    `;
    document.querySelector("#reviewModal .card").appendChild(msg);
  }
}



// ----- 1) Reset Button Wiring -----
const resetBtn = document.getElementById("resetReviewBtn");
if (resetBtn) {
  resetBtn.addEventListener("click", () => {
    // refill pool & zero progress
    reviewPool = filteredData.map((_, i) => i);
    reviewedCount = 0;
    // draw fresh first batch
    drawBatch();
  });
}

// ----- 2) Preserve state on Exit Review -----
document.querySelectorAll("#reviewModal .close-btn")
  .forEach(btn => {
    btn.addEventListener("click", e => {
      // stop auto if needed
      if (autoModeActive) toggleAutoMode("review");
      // hide review modal, show import screen
      document.getElementById("reviewModal").style.display = "none";
      document.getElementById("importScreen").style.display = "flex";
      showTagFilters();
      // (we do NOT clear reviewPool or reviewedCount—state is preserved)
    });
  });




// === Helpers ===
function numLots() {
  return Math.ceil(filteredData.length / LOT_SIZE);
}// ——— Compute the start/end indices of the current 100-card lot ———

function getLotBounds() {
  const start = (lotIndex - 1) * LOT_SIZE;
  const end = Math.min(lotIndex * LOT_SIZE, filteredData.length) - 1;
  return { start, end };
}

function normalizeTags(tagField) {
  let tags = [];
  if (Array.isArray(tagField)) tags = tagField;
  else if (typeof tagField === "string") tags = [tagField];
  return tags.map(t => t.trim()).filter(t => t.length > 0);
}

function getFiltered() {
  // debug: see what tags we think are selected
  console.log("getFiltered() using selectedTags:", selectedTags);

  if (selectedTags.length === 0) {
    // no filter = everything
    return [...data];
  }

  return data.filter(card => {
    const tags = normalizeTags(card.tag);
    // if “no-tag” was selected and this card has none
    if (selectedTags.includes("no-tag") && tags.length === 0) {
      return true;
    }
    // otherwise at least one tag must match
    return tags.some(t => selectedTags.includes(t));
  });
}



function calculateBrightness(imageData) {
  let total = 0, count = 0, d = imageData.data;
  for (let i = 0; i < d.length; i += 16) {
    total += (d[i] + d[i + 1] + d[i + 2]) / 3;
    count++;
  }
  return total / count;
}

function flipWithinLot(e, renderFn) {
  const start = (lotIndex - 1) * LOT_SIZE;
  const end = Math.min(lotIndex * LOT_SIZE, filteredData.length) - 1;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  currentIndex = x < rect.width / 2
    ? (currentIndex > start ? currentIndex - 1 : end)
    : (currentIndex < end ? currentIndex + 1 : start);
  renderFn();
}
/*
function stopAutoReview() {
  if (reviewInterval) {
    clearInterval(reviewInterval);
    reviewInterval = null;
  }
}
*/
// ——— Auto‐study stop helper ———
function stopAutoStudy() {
  if (studyInterval) {
    clearInterval(studyInterval);
    studyInterval = null;
  }
}

/*
function restartAutoReview() {
  if (!autoModeActive) return;
  clearInterval(reviewInterval);
  reviewInterval = setInterval(() => {
    // only advance if the light is on and we have cards in the current batch
    if (lightDetected && currentBatch.length) {
      // advance batchIndex, wrapping to 0 at the end
      batchIndex = (batchIndex + 1) % currentBatch.length;
      reviewShowCard();
    }
  }, currentTimer * 1000);
}
*/


function restartAutoStudy() {
  if (!autoModeActive) return;
  clearInterval(studyInterval);
  studyInterval = setInterval(() => {
    if (lightDetected && filteredData.length) {
      const { start, end } = getLotBounds();
      // loop only within this lot
      currentIndex = (currentIndex < end ? currentIndex + 1 : start);
      studyShowCard();
      updateStudyCounters();
    }
  }, currentTimer * 1000);
}

async function startCamera(videoEl, statusEl) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
    videoEl.srcObject = stream;
    videoEl.style.display = 'none';
    videoEl.addEventListener('loadedmetadata', () => {
      startBrightnessDetection(videoEl, statusEl);
    }, { once: true });
  } catch (err) {
    console.error("Camera error:", err);
    statusEl.textContent = "Camera not available";
    statusEl.style.display = "block";
    autoModeActive = false;
  }
}

// ─── 4) Brightness only gates the timer path ────────────────────────────────
function startBrightnessDetection(videoEl, statusEl) {
  let darkCount = 0, prevLight = true;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  clearInterval(detectionInterval);
  detectionInterval = setInterval(() => {
    if (!videoEl.videoWidth) return;

    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    ctx.drawImage(videoEl, 0, 0);
    const bd = calculateBrightness(ctx.getImageData(0, 0, canvas.width, canvas.height));
    darkCount = bd < darknessThreshold
      ? Math.min(darkCount + 1, REQUIRED_DARK_FRAMES + 1)
      : 0;
    const isLight = darkCount < REQUIRED_DARK_FRAMES;

    if (!autoModeActive) {
      statusEl.style.display = 'none';
      prevLight = isLight;
      return;
    }

    statusEl.style.display = hasAudioForCurrent() ? 'none' : statusEl.style.display;

    // Only gate the **timer** if there’s no audio on this card:
    if (!hasAudioForCurrent()) {
      if (!isLight && prevLight) {
        statusEl.textContent = 'PAUSED (Dark)';
        statusEl.style.display = 'block';
        clearTimeout(autoReviewTimeout);
      }
      else if (isLight && !prevLight) {
        statusEl.style.display = 'none';
        scheduleNextByTimer();
      }
    }

    prevLight = isLight;
  }, 150);
}
function hasAudioForCurrent() {
  if (!filteredData.length || !currentBatch.length) return false;
  const idx = currentBatch[batchIndex];
  return audioEnabled && !!filteredData[idx].audioContent;
}


function stopCamera(videoEl) {
  if (videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
  clearInterval(detectionInterval);
}

/**
 * Renders the tag pills for the current review batch card,
 * wiring each pill to toggle that tag on the card and then
 * re-render the entire card (star + tags + content).
 */
async function renderCardTags(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  // Determine which card we're on
  const realIdx = currentBatch[batchIndex];
  const card = filteredData[realIdx];
  const cardTags = normalizeTags(card.tag || []);

  // 2) “+ Add Tag” pill
  const addBtn = document.createElement("button");
  addBtn.textContent = "+ Add Tag";
  addBtn.className = "tag-pill add-tag";
  addBtn.addEventListener("click", () => {
    const raw = prompt("Enter new tag name:");
    if (!raw) return;
    const norm = raw.trim().replace(/\s+/g, "-").toLowerCase();

    card.tag = normalizeTags(card.tag || []);
    if (!card.tag.includes(norm)) card.tag.push(norm);

    if (!availableTags.includes(norm)) {
      availableTags.push(norm);
      showTagFilters();
    }

    reviewShowCard();
  });
  container.appendChild(addBtn);
}

// 1) renderStudyCardTags — mirrors Review’s tag logic but for Study
async function renderCardTags(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  const realIdx  = currentBatch[batchIndex];
  const card     = filteredData[realIdx];
  const cardTags = normalizeTags(card.tag || []);

  availableTags.forEach(tag => {
    const btn = document.createElement("button");
    btn.textContent = tag;
    btn.className = "tag-pill" + (cardTags.includes(tag) ? " selected" : "");
    btn.addEventListener("click", () => {
      // toggle this tag on the card
      if (cardTags.includes(tag)) {
        card.tag = cardTags.filter(t => t !== tag);
      } else {
        card.tag = [...cardTags, tag];
      }
      reviewShowCard();  // re‐draw star + tags immediately
    });
    container.appendChild(btn);
  });

  const addBtn = document.createElement("button");
addBtn.textContent = "+ Add Tag";
addBtn.className = "tag-pill add-tag";
addBtn.addEventListener("click", () => {
  const raw = prompt("Enter new tag name:");
  if (!raw) return;
  const norm = raw.trim().replace(/\s+/g, "-").toLowerCase();

  // attach to this card
  card.tag = normalizeTags(card.tag || []);
  if (!card.tag.includes(norm)) {
    card.tag.push(norm);
  }

  // add globally for filters
  if (!availableTags.includes(norm)) {
    availableTags.push(norm);
    showTagFilters();  // update filter list
  }

  reviewShowCard();   // re‐draw star + tags immediately
});
container.appendChild(addBtn);
}

// 2) studyShowCard — show question, answers, star & tags, then counters
function studyShowCard() {
  if (!filteredData.length) return;
  const c = filteredData[currentIndex];

  // Question
  document.getElementById("studyQuestion").textContent =
    c.question || "No question";

  // Phrase highlight
  document.getElementById("studyPhrase").innerHTML =
    highlightApprox(c.phrase || "", c.question || "");

  // Answers randomized
  const correctEl = document.getElementById("correctAnswer");
  const incorrectEl = document.getElementById("incorrectAnswer");
  correctEl.classList.remove("selected");
  incorrectEl.classList.remove("selected");

  let wrong;
  do {
    wrong = filteredData[Math.floor(Math.random() * filteredData.length)].answer;
  } while (wrong === c.answer && filteredData.length > 1);

  const pair = document.querySelector("#studyModal .answer-pair");
  pair.innerHTML = "";
  if (Math.random() < 0.5) {
    incorrectEl.textContent = wrong;
    correctEl.textContent = c.answer;
    pair.append(incorrectEl, correctEl);
  } else {
    correctEl.textContent = c.answer;
    incorrectEl.textContent = wrong;
    pair.append(correctEl, incorrectEl);
  }

  // Star reflecting “favourite”
  const tags = normalizeTags(c.tag || []);
  document.getElementById("studyFavouriteStar").textContent =
    tags.includes("favourite") ? "★" : "☆";

  // Render tags and wire them up
  renderStudyCardTags();

  // Update counters
  updateStudyCounters();
}

// 3) beginStudy — invoked by your Start Study button
function beginStudy() {
  const selected = Array.from(
    document.querySelectorAll('#tagCheckboxes input:checked')
  ).map(cb => cb.value);

  if (selected.length === 0) {
    showError("Please choose at least one filter.");
    return;
  }

  filteredData = getFiltered();
  if (filteredData.length === 0) {
    showError("No cards found for that filter.");
    return;
  }

  // Chunk & shuffle into lots of 100 (unchanged)
  const lots = [];
  const totalLots = numLots();
  for (let i = 0; i < totalLots; i++) {
    const start = i * LOT_SIZE;
    const end = Math.min(start + LOT_SIZE, filteredData.length);
    const chunk = filteredData.slice(start, end);
    shuffleArray(chunk);
    lots.push(chunk);
  }
  filteredData = lots.flat();

  // Reset & show first card
  lotIndex = 1;
  currentIndex = 0;
  studyShowCard();
  updateStudyCounters();

  isInReviewMode = false;
  isInStudyMode = true;
  document.getElementById("importScreen").style.display = "none";
  document.getElementById("studyModal").style.display = "flex";
}





// 1) LCS-based length calculator
function computeLCS(a, b) {
  const m = a.length, n = b.length;
  const dp = Array(m + 1).fill().map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// ——— Escape regex metachars ———
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ——— Highlight approx ———
function highlightApprox(phrase, question) {
  if (!question) return phrase;
  const q = question.trim();
  // 1) If multi-word, do exact substring match
  if (/\s+/.test(q)) {
    const re = new RegExp(escapeRegex(q), 'gi');
    return phrase.replace(re, match =>
      `<span class="question-highlight">${match}</span>`
    );
  }
  // 2) Single word: prefix match of (length–2) letters
  const qw = q.toLowerCase();
  const L = qw.length;
  const threshold = Math.max(1, L - 2);

  return phrase.split(/(\b\w+\b)/).map(token => {
    if (!/^\w+$/.test(token)) return token;
    const w = token.toLowerCase();
    if (w.startsWith(qw.slice(0, threshold))) {
      return `<span class="question-highlight">${token}</span>`;
    }
    return token;
  }).join('');
}

function updateStudyCounters() {
  const within = (currentIndex % LOT_SIZE) + 1;
  const lotTotal = Math.min(
    LOT_SIZE,
    filteredData.length - (lotIndex - 1) * LOT_SIZE
  );
  document.getElementById("studyCardCounter").textContent =
    `${within}/${lotTotal}`;
  document.getElementById("studyLotCounter").textContent =
    `${lotIndex}/${numLots()}`;
}

// === DOMContentLoaded Wiring ===
document.addEventListener("DOMContentLoaded", async () => {

  // grab your question/answer nodes
  const questionEl = document.getElementById("question");
  const answerEl = document.getElementById("answer");

  // make them look clickable
  questionEl.style.cursor = "pointer";
  answerEl.style.cursor = "pointer";

  // Import‐screen elements
  const loadOptions = document.getElementById("loadOptions");
  const fileInput = document.getElementById("fileInput");
  const startReviewBtn = document.getElementById("startReviewBtn");
  const startStudyBtn = document.getElementById("startStudyBtn");


  // Shared controls for multiple elements
  const incrementTimerBtns = document.querySelectorAll(".incrementTimer");
  const decrementTimerBtns = document.querySelectorAll(".decrementTimer");
  const timerDisplays = document.querySelectorAll(".timerDisplay");
  const incrementThreshBtns = document.querySelectorAll(".incrementThreshold");
  const decrementThreshBtns = document.querySelectorAll(".decrementThreshold");
  const thresholdDisplays = document.querySelectorAll(".thresholdDisplay");

  const exportBtn = document.getElementById("exportBtn");
  exportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFileName || "qa_data_updated.json";  // ← use original name
    a.click();
    URL.revokeObjectURL(url);
  });

  exportBtn.style.display = "none";  // hide export until after import

  // Toggle question ↔ pronunciation
  questionEl.style.cursor = "pointer";
  questionEl.addEventListener("click", e => {
    e.stopPropagation();
    const { front, back, showing } = questionEl.dataset;
    if (!back) {
      // no pronunciation → show inline note
      let note = questionEl.nextElementSibling;
      if (!note || !note.classList.contains("inline-note")) {
        note = document.createElement("div");
        note.className = "inline-note";
        note.textContent = "No pronunciation";
        questionEl.parentNode.insertBefore(note, questionEl.nextSibling);
        setTimeout(() => note.remove(), 1500);
      }
      return;
    }
    // toggle front/back
    questionEl.textContent = showing === "front" ? back : front;
    questionEl.dataset.showing = showing === "front" ? "back" : "front";
  });

  // Toggle answer ↔ meaning
  answerEl.addEventListener("click", e => {
    e.stopPropagation();
    const { front, back, showing } = answerEl.dataset;
    if (!back) {
      // show “No meaning” inline note
      let note = answerEl.nextElementSibling;
      if (!note || !note.classList.contains("inline-note")) {
        note = document.createElement("div");
        note.className = "inline-note";
        note.textContent = "No meaning";
        answerEl.parentNode.insertBefore(note, answerEl.nextSibling);
        setTimeout(() => note.remove(), 1500);
      }
      return;
    }
    answerEl.textContent = showing === "front" ? back : front;
    answerEl.dataset.showing = showing === "front" ? "back" : "front";
  });

  // 1) “All” toggle
  const selectAll = document.getElementById("selectAllTags");
  selectAll.addEventListener("change", e => {
    const checked = e.target.checked;
    const boxes = Array.from(
      document.querySelectorAll("#tagCheckboxes input[type='checkbox']")
    );
    boxes.forEach(b => b.checked = checked);
    // Update selectedTags
    selectedTags = checked ? boxes.map(b => b.value) : [];
  });

  const tagContainer = document.getElementById("tagCheckboxes");
  tagContainer.addEventListener("change", () => {
    const boxes = Array.from(
      tagContainer.querySelectorAll("input[type='checkbox']")
    );
    selectAll.checked = boxes.length > 0 && boxes.every(b => b.checked);
    selectedTags = boxes.filter(b => b.checked).map(b => b.value);
  });


  document.querySelectorAll('.toggleAutoMode.review')
    .forEach(b => b.addEventListener('click', () => toggleAutoMode('review')));

  document.querySelectorAll('.toggleAutoMode.study')
    .forEach(b => b.addEventListener('click', () => toggleAutoMode('study')));


  // Review modal controls
  const reviewContent = document.getElementById("reviewContent");
  const reviewFavouriteStar = document.getElementById("reviewFavouriteStar");

  // Study modal controls
  const studyContent = document.getElementById("studyContent");
  const studyFavouriteStar = document.getElementById("studyFavouriteStar");
  const sPrevLotBtn = document.getElementById("studyPrevLot");
  const sNextLotBtn = document.getElementById("studyNextLot");


  fileInput.addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) {
      showError("No file selected!");
      return;
    } 
  
    const reader = new FileReader();
  
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        showError("Failed to parse JSON: " + err.message);
        return;
      }
  
      // assign to app state
      data = parsed;
  
      // update card count immediately
      document.getElementById("cardCount").textContent =
        "Total cards: " + (Array.isArray(data) ? data.length : "—");
  
      // reveal the import controls
      updateCardCount();
      document.getElementById("importControls").style.display = "flex";
      document.getElementById("tagFilterContainer").style.display = "block";
      document.getElementById("startStudyBtn").style.display = "inline-block";
      document.getElementById("startReviewBtn").style.display = "inline-block";
      document.getElementById("exportBtn").style.display = "inline-block";
  
      lotIndex = 1;
      currentIndex = 0;
  
      showTagFilters();
    };
  
    reader.onerror = () => {
      showError("Could not read file: " + reader.error);
    };
  
    reader.readAsText(file);
  });
  
  
  
  
  


  // 4) Download JSON
  exportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFileName || "qa_data_updated.json";
    a.click();
    URL.revokeObjectURL(url);
  });
  

  // 5) Timer controls (review)
  // Initialize displays
  timerDisplays.forEach(display => display.textContent = currentTimer);

  // Increment timer
  incrementTimerBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      currentTimer = Math.min(currentTimer + 0.5, 60);
      timerDisplays.forEach(display =>
        display.textContent = currentTimer % 1 === 0
          ? currentTimer
          : currentTimer.toFixed(1)
      );

      // Restart the auto‐review loop (or study) with the new timer
      if (autoModeActive) {
        if (isInReviewMode) {
          autoAdvanceReview();
        }
        if (isInStudyMode) {
          restartAutoStudy();
        }
      }
    });
  });

  // Decrement timer
  decrementTimerBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      currentTimer = Math.max(currentTimer - 0.5, 0.5);
      timerDisplays.forEach(display =>
        display.textContent = currentTimer % 1 === 0
          ? currentTimer
          : currentTimer.toFixed(1)
      );

      // Restart the auto‐review loop (or study) with the new timer
      if (autoModeActive) {
        if (isInReviewMode) {
          autoAdvanceReview();
        }
        if (isInStudyMode) {
          restartAutoStudy();
        }
      }
    });
  });



  // 6) Threshold controls (review)
  thresholdDisplays.forEach(display => display.textContent = darknessThreshold);
  incrementThreshBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      darknessThreshold = Math.min(darknessThreshold + 10, 250);
      thresholdDisplays.forEach(display => display.textContent = darknessThreshold);
    });
  });
  decrementThreshBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      darknessThreshold = Math.max(darknessThreshold - 10, 0);
      thresholdDisplays.forEach(display => display.textContent = darknessThreshold);
    });
  });


  startReviewBtn.addEventListener("click", () => {
    // If we're mid-session *and* the filters haven't changed, resume
    const sortedSelected = [...selectedTags].sort();
    if ((reviewPool.length > 0 || reviewedCount > 0)
      && sameTags(sortedSelected, reviewSessionTags)) {
      document.getElementById("importScreen").style.display = "none";
      document.getElementById("reviewModal").style.display = "flex";
      updateProgressBar();
      reviewShowCard();
    } else {
      // Otherwise, start a brand-new session with the new tags
      beginReview();
    }
  });



  // 9) Favourite toggle (review)
  document.getElementById("reviewFavouriteStar")
    .addEventListener("click", e => {
      e.stopPropagation();
      const realIdx = currentBatch[batchIndex];
      const card = filteredData[realIdx];
      card.tag = normalizeTags(card.tag || []);

      const favPos = card.tag.indexOf("favourite");
      if (favPos === -1) card.tag.push("favourite");
      else card.tag.splice(favPos, 1);

      reviewShowCard();
    });


  // 10) Tap‐to‐flip / advance (review)
  // ——— Review content prev/next tap handler ———
  reviewContent.addEventListener("click", e => {
    // ignore clicks on the star, question, answer, or any tag pills
    if (
      e.target.closest("#reviewFavouriteStar") ||
      e.target.closest("#question") ||
      e.target.closest("#answer") ||
      e.target.closest(".tag-pill")
    ) return;

    // determine click position
    const rect = reviewContent.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const half = rect.width / 2;

    if (clickX < half) {
      // left side: previous card (wrap around)
      batchIndex = (batchIndex - 1 + currentBatch.length) % currentBatch.length;
    } else {
      // right side: next card (wrap around)
      batchIndex = (batchIndex + 1) % currentBatch.length;
    }

    reviewShowCard();
  });


  // 12) Pagination (study)
  sPrevLotBtn.addEventListener("click", () => {
    lotIndex = lotIndex > 1 ? lotIndex - 1 : numLots();
    currentIndex = (lotIndex - 1) * LOT_SIZE;
    studyShowCard(); updateStudyCounters();
  });
  sNextLotBtn.addEventListener("click", () => {
    lotIndex = lotIndex < numLots() ? lotIndex + 1 : 1;
    currentIndex = (lotIndex - 1) * LOT_SIZE;
    studyShowCard(); updateStudyCounters();
  });

  // 13) Start study
  startStudyBtn.addEventListener("click", beginStudy);

  // 14a) Answer-selection logic (study modal)
  const correctEl = document.getElementById("correctAnswer");
  const incorrectEl = document.getElementById("incorrectAnswer");

  correctEl.addEventListener("click", e => {
    e.stopPropagation();
    // show green briefly
    correctEl.classList.add("selected");
    setTimeout(() => {
      correctEl.classList.remove("selected");
      // advance within this lot
      const start = (lotIndex - 1) * LOT_SIZE;
      const end = Math.min(lotIndex * LOT_SIZE, filteredData.length) - 1;
      currentIndex = (currentIndex < end) ? currentIndex + 1 : start;
      studyShowCard();
      updateStudyCounters();
    }, 500);
  });

  incorrectEl.addEventListener("click", e => {
    e.stopPropagation();
    // show grey briefly
    incorrectEl.classList.add("selected");
    setTimeout(() => {
      incorrectEl.classList.remove("selected");
    }, 500);
  });

  // 14) Favourite toggle (study)
  studyFavouriteStar.addEventListener("click", e => {
    e.stopPropagation();
    const card = filteredData[currentIndex];
    card.tag = normalizeTags(card.tag || []);

    const idx = card.tag.indexOf("favourite");
    if (idx === -1) card.tag.push("favourite");
    else card.tag.splice(idx, 1);

    studyShowCard();
  });

  // 15) Tap‐to‐flip (study)
  studyContent.addEventListener("click", e => {
    if (
      e.target.closest("#studyFavouriteStar") ||
      e.target.closest("#studyQuestion") ||
      e.target.closest("#correctAnswer") ||
      e.target.closest("#incorrectAnswer")
    ) return;
    flipWithinLot(e, () => {
      studyShowCard();
      updateStudyCounters();
    });
  });


  document.querySelectorAll(".close-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      const modalEl = e.target.closest(".modal");
      if (autoModeActive) {
        // derive "review" or "study" from the modal's ID (e.g. "reviewModal")
        const context = modalEl.id.replace("Modal", "");
        toggleAutoMode(context);
      }
      modalEl.style.display = "none";
      document.getElementById("importScreen").style.display = "flex";
      showTagFilters();
    });
  });


  // 18) Initialize counters
  updateStudyCounters();

  // 2) Wire buttons
  document.getElementById("cancelCardBtn")
    .addEventListener("click", closeAddCardModal);
  document.getElementById("saveCardBtn")
    .addEventListener("click", saveNewCard);
  document.getElementById("addNewTagBtn")
    .addEventListener("click", handleAddNewTag);

  const audioToggleBtn = document.getElementById("audioToggleBtn");
  audioToggleBtn.addEventListener("click", async () => {
    audioEnabled = !audioEnabled;
    audioToggleBtn.textContent = audioEnabled ? "🔊" : "🔇";

    // Create the context on first use
    if (audioEnabled && !audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // If it’s suspended (iOS default), resume it
    if (audioCtx && audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
  });

  // Unlock AudioContext on any first touch, for Safari touch-only scenarios:
  document.body.addEventListener("touchend", async () => {
    if (audioCtx && audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
  }, { once: true });

  // If user leaves and returns, make sure the AudioContext is still running
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible"
      && audioCtx
      && audioCtx.state === "suspended") {
      // small delay can help on some buggy WebKit builds
      setTimeout(() => audioCtx.resume(), 100);
    }
  });

  // 1) Grab our new buttons & elements
  const importImageBtn = document.getElementById('importImageBtn');
  const imgImportModal = document.getElementById('imgImportModal');
  const imgFileInput = document.getElementById('imgFileInput');
  const toCrop = document.getElementById('toCrop');
  const cancelImport = document.getElementById('cancelImport');
  const doneImport = document.getElementById('doneImport');
  const cropButtons = document.querySelectorAll('#imgImportModal button[data-field]');


  const toCropImg = document.getElementById('toCrop');
  const cropQuestionBtn = document.getElementById('cropQuestionBtn');
  const cropAnswerBtn = document.getElementById('cropAnswerBtn');
  const cropPhraseBtn = document.getElementById('cropPhraseBtn');
  const doneImportBtn = document.getElementById('doneImport');
  const cancelImportBtn = document.getElementById('cancelImport');


  let cropper = null;
  let pendingField = null;

  let imageCrops = {
    question: "",
    answer: "",
    phrase: ""
  };

  const addCardTextBtn = document.getElementById('addCardTextBtn');
  addCardTextBtn.addEventListener('click', () => {
    // open your existing text‐entry Add-Card modal:
    openAddCardModal();
  });
  // 2) Open the Image‐Import modal
  document.getElementById('importImageBtn').addEventListener('click', () => {
    imgFileInput.value = '';
    toCropImg.style.display = 'none';
    [cropQuestionBtn, cropAnswerBtn, cropPhraseBtn, doneImportBtn].forEach(b => b.disabled = true);
    imgImportModal.style.display = 'flex';
  });
  cancelImportBtn.addEventListener('click', () => {
    if (cropper) { cropper.destroy(); cropper = null; }
    imgImportModal.style.display = 'none';
  });
  const addCardMenuBtn = document.getElementById('addCardMenuBtn');
  addCardMenuBtn.addEventListener('click', e => e.preventDefault());
  // 3) Load & initialize Cropper when an image is chosen
  imgFileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    toCropImg.src = url;
    toCropImg.style.display = 'block';

    if (cropper) cropper.destroy();
    cropper = new Cropper(toCropImg, {
      viewMode: 1,
      autoCrop: false,
      background: false,
    });

    // enable each crop button
    [cropQuestionBtn, cropAnswerBtn, cropPhraseBtn].forEach(b => b.disabled = false);
  });

  // 4) For each “Crop X” button, OCR that region into the matching input
  cropButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!cropper) {
        return alert("Please pick and load an image first!");
      }
      const field = btn.dataset.field;          // "question", "answer" or "phrase"
      const canvas = cropper.getCroppedCanvas({ width: 800 });
      try {
        const { data: { text } } = await Tesseract.recognize(canvas, 'eng');
        imageCrops[field] = text.trim();        // store it
        // immediately update your form so you can visually confirm:
        const inputId = ({
          question: "newQuestion",
          answer: "newAnswer",
          phrase: "newPhrase"
        })[field];
        document.getElementById(inputId).value = imageCrops[field];
      } catch (ocrErr) {
        console.error("OCR failed for", field, ocrErr);
        alert("OCR failed, please try again.");
      }
    });
  });

  function doCrop(field) {
    if (!cropper) return;
    const canvas = cropper.getCroppedCanvas({ maxWidth: 800, maxHeight: 600 });
    imageCrops[field] = canvas.toDataURL('image/png');
    // visually mark button as done
    document.querySelector(`#crop${field.charAt(0).toUpperCase() + field.slice(1)}Btn`)
      .textContent = `✔ ${field}`;
    // enable “Done” once all three are cropped
    if (imageCrops.question && imageCrops.answer && imageCrops.phrase) {
      doneImportBtn.disabled = false;
    }
  }

  cropQuestionBtn.addEventListener('click', () => doCrop('question'));
  cropAnswerBtn.addEventListener('click', () => doCrop('answer'));
  cropPhraseBtn.addEventListener('click', () => doCrop('phrase'));

  doneImportBtn.addEventListener('click', () => {
    // Validate we actually got something
    if (!imageCrops.question || !imageCrops.answer || !imageCrops.phrase) {
      return alert("Please crop all three fields (Question, Answer, Phrase).");
    }

    // Hide the image‐import modal
    document.getElementById("imgImportModal").style.display = "none";
    if (cropper) {
      cropper.destroy();
      cropper = null;
    }

    // Show the text‐based “Add New Card” modal
    openAddCardModal();  // this already clears and shows the text form

    // Since openAddCardModal wipes the inputs, re-fill them:
    document.getElementById("newQuestion").value = imageCrops.question;
    document.getElementById("newAnswer").value = imageCrops.answer;
    document.getElementById("newPhrase").value = imageCrops.phrase;
    // pronunciation stays blank or could be OCR’d if you add it
  });



  // 5) “Done” → close and hand off to your existing Add-Card modal
  doneImport.addEventListener('click', () => {
    imgImportModal.style.display = 'none';
    if (cropper) cropper.destroy();
    toCrop.style.display = 'none';
    document.getElementById('addCardModal').style.display = 'flex';
  });

  // 6) “Cancel” → just close it
  cancelImport.addEventListener('click', () => {
    imgImportModal.style.display = 'none';
    if (cropper) cropper.destroy();
    toCrop.style.display = 'none';
  });


  // 3) Initialize count at startup
  updateCardCount();

});

// === Flows ===
// Utility: Fisher–Yates shuffle
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function beginReview() {
  // Gather which tags are checked
  const selected = Array.from(
    document.querySelectorAll('#tagCheckboxes input:checked')
  ).map(cb => cb.value);

  if (selected.length === 0) {
    showError("Please choose at least one filter.");
    return;
  }

  // Filter the data
  filteredData = getFiltered();
  if (filteredData.length === 0) {
    showError("No cards found for that filter.");
    return;
  }

  // Remember these tags so "Resume Review" works correctly
  reviewSessionTags = [...selectedTags].sort();

  // Reset and draw our first 20-card batch
  reviewPool    = [];
  reviewedCount = 0;
  drawBatch();

  // Show the Review modal
  isInReviewMode = true;
  isInStudyMode  = false;
  document.getElementById("importScreen").style.display  = "none";
  document.getElementById("reviewModal").style.display  = "flex";
}



function sameTags(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}


// ——— Finish Batch button wiring ———
document.getElementById("finishBatchBtn")
  .addEventListener("click", () => {
    const total = filteredData.length;
    reviewedCount += currentBatch.length;

    if (reviewedCount >= total) {
      // 1) Render an all-green bar at 100%
      const bar = document.getElementById('reviewProgressBar');
      bar.innerHTML = `
        <div class="reviewed" style="flex:${total}; justify-content:flex-end; padding-right:8px;">
          ${total} (100%)
        </div>
      `;

      // 2) Show the completion overlay
      const cardEl = document.querySelector("#reviewModal .card");
      const overlay = document.createElement("div");
      overlay.id = "completionOverlay";
      overlay.textContent = "You have reviewed all cards";
      Object.assign(overlay.style, {
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        background: "rgba(0,0,0,0.8)",
        color: "#fff",
        padding: "1rem 2rem",
        borderRadius: "8px",
        zIndex: "1001",
        textAlign: "center",
        fontSize: "1.2rem",
      });
      cardEl.appendChild(overlay);

      // 3) After 1 second, remove overlay and reset everything
      setTimeout(() => {
        overlay.remove();
        reviewPool = [];    // clear for a fresh session
        reviewedCount = 0;
        drawBatch();          // goes back to batch #1
      }, 1000);
    } else {
      // normal path: draw next batch with in-progress (purple) segment
      drawBatch();
    }
  });


// put this near the top of your script.js
function showError(msg) {
  const err = document.getElementById("filterError");
  err.textContent = msg;
  err.style.display = "block";
  // force a style recalc so the transition runs
  requestAnimationFrame(() => {
    err.style.opacity = "1";
  });
  // after 1s, fade out and then hide
  setTimeout(() => {
    err.style.opacity = "0";
    err.addEventListener("transitionend", () => {
      err.style.display = "none";
    }, { once: true });
  }, 1000);
}

/**
 * Call ElevenLabs Text-to-Speech API and return base64 MP3.
 * @param {string} text  The phrase to synthesize.
 * @returns {Promise<string>}  Base64-encoded MP3 audio.
 */
async function fetchPhraseAudio(text) {
  const apiKey = "sk_7faf124d4796e1bab67c14ac0fd1abfe2bd10180400d2ccf";
  const voiceId = "56AoDkrOh6qfVPDXZ7Pt";  // your voice’s ID
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": apiKey
    },
    body: JSON.stringify({
      text,                                 // the only required field
      // optional settings—you can omit these initially
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    })
  });

  if (!res.ok) {
    // try to parse their error JSON
    let errDetail = "";
    try {
      const errJson = await res.json();
      errDetail = errJson.detail || JSON.stringify(errJson);
    } catch (e) {
      errDetail = await res.text();
    }
    console.error("ElevenLabs TTS error response:", errDetail);
    throw new Error(errDetail);
  }

  // on success, we get raw MP3 bytes
  const arrayBuffer = await res.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(arrayBuffer)
      .reduce((data, byte) => data + String.fromCharCode(byte), "")
  );
  return base64;
}

function openAddCardModal() {
  // 1) Clear all text inputs
  document.getElementById("newQuestion").value = "";
  document.getElementById("newAnswer").value = "";
  document.getElementById("newPronunciation").value = "";
  document.getElementById("newPhrase").value = "";

  // 2) Clear the tag-input and reset selected-tags
  document.getElementById("newTagInput").value = "";
  newCardSelectedTags = [];

  // 3) Build the tag-pills UI fresh
  renderNewCardTags();

  // 4) Show the Add-Card modal
  document.getElementById("addCardModal").style.display = "flex";
}


function closeAddCardModal() {
  document.getElementById("addCardModal").style.display = "none";
}
function updateCardCount() {
  document.getElementById("cardCount").textContent =
    `Total cards: ${data.length}`;
}
async function saveNewCard() {
  const qEl = document.getElementById("newQuestion");
  const aEl = document.getElementById("newAnswer");
  const pEl = document.getElementById("newPronunciation");
  const phEl = document.getElementById("newPhrase");

  // 1) Basic validation
  if (!qEl.value.trim() || !aEl.value.trim()) {
    alert("Question & Answer are required.");
    return;
  }

  // 2) Build the new card object
  const newCard = {
    question: qEl.value.trim(),
    answer: aEl.value.trim(),
    pronunciation: pEl.value.trim(),
    phrase: phEl.value.trim(),
    tag: newCardSelectedTags.length
      ? [...newCardSelectedTags]
      : ["no-tag"],
    audioContent: null   // will fill below if possible
  };

  // 3) (Optional) One-off TTS for the phrase
  if (newCard.phrase) {
    try {
      newCard.audioContent = await fetchPhraseAudio(newCard.phrase);
    } catch (ttsErr) {
      console.warn("TTS failed, saving without audio:", ttsErr);
      // show inline note below the phrase field
      const note = document.createElement("div");
      note.className = "inline-note";
      note.textContent = "⚠️ Audio generation failed; saving without audio.";
      phEl.parentNode.insertBefore(note, phEl.nextSibling);
      setTimeout(() => note.remove(), 3000);
    }
  }

  // 4) Append to in-memory data & refresh count
  data.push(newCard);
  updateCardCount();

  // 5) Clear the form and close the modal
  [qEl, aEl, pEl, phEl].forEach(el => el.value = "");
  document.getElementById("newTagInput").value = "";
  newCardSelectedTags = [];
  renderNewCardTags();
  closeAddCardModal();
}


function renderNewCardTags() {
  const container = document.getElementById('newTagContainer');
  if (!container) return;  // Safety check: container should exist

  // Clear out any existing tag buttons
  container.innerHTML = '';

  // Rebuild the tag buttons from scratch
  availableTags.forEach(tag => {
    // Create a button element for the tag
    const tagBtn = document.createElement('button');
    tagBtn.textContent = tag;
    tagBtn.classList.add('tag-pill');            // base styling class for all tag pills
    if (newCardSelectedTags.includes(tag)) {
      tagBtn.classList.add('selected');        // highlight if this tag is selected
    }

    // Click event to toggle selection on/off
    tagBtn.addEventListener('click', () => {
      if (newCardSelectedTags.includes(tag)) {
        // If already selected, remove it from selected list
        newCardSelectedTags = newCardSelectedTags.filter(t => t !== tag);
        tagBtn.classList.remove('selected');
      } else {
        // If not selected, add to selected list
        newCardSelectedTags.push(tag);
        tagBtn.classList.add('selected');
      }
    });

    // Append the button to the tag container in the modal
    container.appendChild(tagBtn);
  });
}


function handleAddNewTag() {
  const tagInputElem = document.getElementById('newTagInput');
  const newTagName = tagInputElem.value.trim();
  if (!newTagName) return;  // Do nothing if input is empty or just whitespace

  // 1. Add the new tag to the availableTags list (avoid duplicates if needed)
  availableTags.push(newTagName);

  // 2. Mark this tag as selected for the new card
  newCardSelectedTags.push(newTagName);

  // 3. Clear the input field for a better UX
  tagInputElem.value = '';

  // 4. Re-render the tag buttons to reflect the new tag immediately
  renderNewCardTags();
}

// ─── reviewShowCard ─────────────────────────────────────────────────────────
function reviewShowCard() {
  if (!filteredData.length || !currentBatch.length) return;
  const realIdx = currentBatch[batchIndex];
  const c = filteredData[realIdx];

  // 1) Question ↔ pronunciation toggle
  const qEl = document.getElementById("question");
  qEl.dataset.front = c.question || "";
  qEl.dataset.back = c.pronunciation || "";
  qEl.textContent = qEl.dataset.front;
  qEl.dataset.showing = "front";

  // 2) Answer ↔ meaning toggle
  const aEl = document.getElementById("answer");
  aEl.dataset.front = c.answer || "";
  aEl.dataset.back = c.meaning || "";
  aEl.textContent = aEl.dataset.front;
  aEl.dataset.showing = "front";

  // 3) Phrase highlight
  document.getElementById("phrase").innerHTML =
    highlightApprox(c.phrase || "", c.question || "");

  // 4) Star & tags
  document.getElementById("reviewFavouriteStar").textContent =
    normalizeTags(c.tag || []).includes("favourite") ? "★" : "☆";
  renderCardTags("reviewCardTags");

  // 5) Counter & progress
  document.getElementById("reviewCardCounter").textContent =
    `${batchIndex + 1}/${currentBatch.length}`;
  updateProgressBar();

  /*
  if (!autoModeActive && audioEnabled && c.audioContent) {
    const audio = new Audio("data:audio/mpeg;base64," + c.audioContent);
    audio.play().catch(err => console.error("Manual audio play failed:", err));
  }*/
}

// ─── 2) Unified autoAdvanceReview ───────────────────────────────────────────
function autoAdvanceReview() {
  clearTimeout(autoReviewTimeout);
  autoReviewTimeout = null;

  if (!autoModeActive || !isInReviewMode) return;

  reviewShowCard();
  const realIdx = currentBatch[batchIndex];
  const card = filteredData[realIdx];

  if (audioEnabled && card.audioContent && audioCtx) {
    // chain audio clips back‐to‐back:
    playAudioViaWebAudio(card.audioContent, () => {
      batchIndex = (batchIndex + 1) % currentBatch.length;
      autoAdvanceReview();
    });
  } else {
    // timer + brightness gating:
    scheduleNextByTimer();
  }
}

// ─── 3) Timer fallback with brightness gating ──────────────────────────────
function scheduleNextByTimer() {
  autoReviewTimeout = setTimeout(() => {
    if (!autoModeActive || !isInReviewMode) return;

    // brightness must be good to actually advance
    if (lightDetected) {
      batchIndex = (batchIndex + 1) % currentBatch.length;
      autoAdvanceReview();
    } else {
      // if dark, wait for light transition
      // (startBrightnessDetection will re‐invoke scheduleNextByTimer on light→dark→light)
    }
  }, currentTimer * 1000);
}

// ─── 5) toggleAutoMode adjusts for WebAudio ─────────────────────────────────
function toggleAutoMode(context) {
  const videoEl = document.getElementById(context + "CameraView");
  const statusEl = document.getElementById(context + "DetectionStatus");
  const btnEl = document.querySelector(`#${context}Modal .toggleAutoMode`);

  autoModeActive = !autoModeActive;
  btnEl.textContent = autoModeActive ? "Disable Auto" : "Enable Auto";

  if (context === "review") {
    if (autoModeActive) {
      lightDetected = true;

      // if audio is on and our AudioContext got suspended on iOS, wake it up
      if (audioEnabled && audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {
          console.warn("AudioContext resume failed (iOS may require a direct tap)");
        });
      }

      startCamera(videoEl, statusEl);
      autoAdvanceReview();
    } else {
      stopCamera(videoEl);
      clearTimeout(autoReviewTimeout);
      // removed any currentAudio handling here
    }

  } else if (context === "study") {
    if (autoModeActive) restartAutoStudy();
    else stopAutoStudy();
  }
}



// ─── 1) Play base64‐MP3 via WebAudio ────────────────────────────────────────
/**
 * Decode a Base64-encoded MP3 and play it via Web Audio,
 * then call onEnded() when playback finishes.
 */
function playAudioViaWebAudio(base64, onEnded) {
  // 1) Convert Base64 string → raw binary string
  const binaryString = atob(base64);

  // 2) Build a Uint8Array from that binary
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // 3) Decode the audio data (Safari-friendly callback form)
  audioCtx.decodeAudioData(
    bytes.buffer,
    decodedBuffer => {
      // 4) Create a source, hook to destination, play, and wire up onEnded
      const src = audioCtx.createBufferSource();
      src.buffer = decodedBuffer;
      src.connect(audioCtx.destination);
      src.onended = onEnded;
      src.start(0);
    },
    err => {
      console.error("WebAudio decode error:", err);
      // Fallback to timer-based advance if decoding/playing fails
      scheduleNextByTimer();
    }
  );
}
