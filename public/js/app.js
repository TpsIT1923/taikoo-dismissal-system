import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc, updateDoc, runTransaction, deleteField } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCYndV2aTf1KEB6yBgjjhOoUIqUKf3jsJY",
  authDomain: "taikoo-dismissal-system.firebaseapp.com",
  projectId: "taikoo-dismissal-system",
  storageBucket: "taikoo-dismissal-system.firebasestorage.app",
  messagingSenderId: "881254467284",
  appId: "1:881254467284:web:b56a348000ce78a0fc5d41",
  measurementId: "G-64B89N4NQJ"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const SCHOOL_DOMAIN = "tps.edu.hk";
const PAGE = document.body.dataset.page || "display";
const isDisplayPage = PAGE === "display";
const isControlPage = PAGE === "control";
const ANNOUNCE_DELAY_MS = 5000;

const ALL_CLASSES = [
  "1A", "1B", "1C", "1D", "1E",
  "2A", "2B", "2C", "2D", "2E",
  "3A", "3B", "3C", "3D", "3E",
  "4A", "4B", "4C", "4D", "4E",
  "5A", "5B", "5C", "5D", "5E",
  "6A", "6B", "6C", "6D", "6E"
];

const DEFAULT_PRESETS = [
  "暴雨警告生效，所有班別延遲放學。",
  "請家長到地下禮堂集合等候。",
  "今日放學程序已全部完成。"
];

const DISMISSAL_DOC_REF = doc(db, "dismissal_system", "live_status");
const DEFAULT_SLIDE_MINUTES = 3;

function getSlideMinutes(data) {
  const minutes = Number(data && data._slideMinutes);
  if (!Number.isFinite(minutes)) return DEFAULT_SLIDE_MINUTES;
  return Math.min(30, Math.max(1, Math.round(minutes)));
}

function getSlideMs(data) {
  return getSlideMinutes(data) * 60 * 1000;
}

let currentFirestoreData = {};
let previousFirestoreData = {};
let currentView = 'display';
let isModalClosedByUser = false;
let isAudioEnabled = false;
let hasLoadedOnce = false;
let expireInFlight = false;
let listenerStarted = false;
const pendingAnnouncements = new Map();

// 語音廣播佇列
let speechQueue = [];
let isSpeaking = false;
let currentAudio = null;

function isSchoolUser(user) {
  return Boolean(user && user.email && user.emailVerified && user.email.toLowerCase().endsWith(`@${SCHOOL_DOMAIN}`));
}

function getGradeClass(className) {
  return `p${className.charAt(0)}`;
}

function getHongKongDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getDismissalAnnouncement(className) {
  const gradeNum = className.charAt(0);
  const gradeLetter = className.charAt(1);
  return `請 ${gradeNum} ${gradeLetter} 班家長準備，你嘅小朋友放學啦！`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showLoading(show) {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.style.display = show ? 'flex' : 'none';
}

// 初始化電子時鐘
function initLiveClock() {
  const clockEl = document.getElementById('liveClock');
  if (!clockEl) return;

  function updateClock() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    clockEl.textContent = `${hours}:${minutes}:${seconds}`;
  }

  updateClock();
  setInterval(updateClock, 1000);
}

initLiveClock();

function paintAudioState() {
  const label = document.getElementById('btnToggleAudio');
  if (!label) return;
  label.textContent = isAudioEnabled ? "關閉廣播" : "開啟廣播";
  label.classList.toggle('is-on', isAudioEnabled);
  label.setAttribute('aria-pressed', isAudioEnabled ? 'true' : 'false');
}

function toggleDisplayAudio() {
  isAudioEnabled = !isAudioEnabled;
  if (isAudioEnabled) {
    speakCantonese("語音廣播系統已開啟");
  } else {
    stopAllAudio();
  }
  paintAudioState();
}

function setupDisplayAudioShortcut() {
  paintAudioState();
  document.getElementById('btnToggleAudio')?.addEventListener('click', toggleDisplayAudio);
  document.getElementById('btnCloseNoticeModal')?.addEventListener('click', () => {
    isModalClosedByUser = true;
    document.getElementById('noticeModal')?.classList.remove('active');
  });
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's')) return;
    event.preventDefault();
    toggleDisplayAudio();
  });
}

function playTestAnnouncement() {
  const audio = new Audio("/audio/1A.m4a");
  audio.play().catch(() => {});
}

function stopAllAudio() {
  speechQueue = [];
  isSpeaking = false;
  window.speechSynthesis?.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

function enqueueAudio(item) {
  if (!isAudioEnabled) return;
  speechQueue.push(item);
  processSpeechQueue();
}

function playClassRecording(className) {
  enqueueAudio({ type: "file", src: `/audio/${className}.m4a` });
}

// 播放叮噹提示音
function playDingDong() {
  if (!isAudioEnabled) return;
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    // 高音叮
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, audioCtx.currentTime); // E5
    gain1.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain1.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.8);
    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);
    osc1.start();
    osc1.stop(audioCtx.currentTime + 0.8);

    // 低音噹
    setTimeout(() => {
      const osc2 = audioCtx.createOscillator();
      const gain2 = audioCtx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(523.25, audioCtx.currentTime); // C5
      gain2.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gain2.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.2);
      osc2.connect(gain2);
      gain2.connect(audioCtx.destination);
      osc2.start();
      osc2.stop(audioCtx.currentTime + 1.2);
    }, 300);
  } catch (e) {
    console.log("AudioContext Error", e);
  }
}

// 廣東話語音朗讀
function speakCantonese(text) {
  enqueueAudio({ type: "speech", text });
}

function finishQueueItem() {
  currentAudio = null;
  isSpeaking = false;
  processSpeechQueue();
}

function processSpeechQueue() {
  if (!isAudioEnabled) {
    stopAllAudio();
    return;
  }
  if (isSpeaking || speechQueue.length === 0) return;

  isSpeaking = true;
  const item = speechQueue.shift();

  if (item.type === "file") {
    const audio = new Audio(item.src);
    currentAudio = audio;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      finishQueueItem();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
    return;
  }

  if (!('speechSynthesis' in window)) {
    finishQueueItem();
    return;
  }

  const utterance = new SpeechSynthesisUtterance(item.text);
  utterance.lang = 'zh-HK';
  utterance.rate = 0.88;
  utterance.onend = finishQueueItem;
  utterance.onerror = finishQueueItem;
  window.speechSynthesis.speak(utterance);
}

function scheduleClassAnnouncement(className, timestamp) {
  const existing = pendingAnnouncements.get(className);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingAnnouncements.delete(className);
    const info = currentFirestoreData[className];
    if (info && info.status === 'active' && info.timestamp === timestamp) {
      playClassRecording(className);
    }
  }, ANNOUNCE_DELAY_MS);
  pendingAnnouncements.set(className, timer);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnResetAll')?.addEventListener('click', resetAllClasses);
  document.getElementById('btnUndoLast')?.addEventListener('click', undoLastDismissal);
  document.getElementById('btnTestSound')?.addEventListener('click', playTestAnnouncement);
  document.getElementById('btnSaveMinutes')?.addEventListener('click', saveSlideMinutes);
  document.getElementById('btnPublishNotice')?.addEventListener('click', publishNotice);
  document.getElementById('btnClearNotice')?.addEventListener('click', clearNotice);
  document.getElementById('btnManagePresets')?.addEventListener('click', managePresets);
  setInterval(checkAndExpireClasses, 1000);
});

function switchView(viewName) {
  currentView = viewName;
  const displayView = document.getElementById('displayView');
  const controlView = document.getElementById('controlView');
  const btnShowDisplay = document.getElementById('btnShowDisplay');
  const btnShowControl = document.getElementById('btnShowControl');

  displayView.classList.remove('active');
  controlView.classList.remove('active');
  btnShowDisplay.classList.remove('active');
  btnShowControl.classList.remove('active');

  if (viewName === 'display') {
    displayView.classList.add('active');
    btnShowDisplay.classList.add('active');
  } else {
    controlView.classList.add('active');
    btnShowControl.classList.add('active');
  }

  renderNoticeOverlay(currentFirestoreData);
}

// 3分鐘自動過期：交易內只改仍然有效的過期班別，避免覆蓋控制台剛重新開啟的班
async function checkAndExpireClasses() {
  if (!currentFirestoreData || expireInFlight) return;
  const now = Date.now();
  const candidates = ALL_CLASSES.filter(cls => {
    const clsInfo = currentFirestoreData[cls];
    return clsInfo && clsInfo.status === 'active' && now - clsInfo.timestamp >= getSlideMs(currentFirestoreData);
  });
  if (candidates.length === 0) return;

  expireInFlight = true;
  try {
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(DISMISSAL_DOC_REF);
      if (!snap.exists()) return;
      const data = snap.data();
      const updates = {};
      const serverNow = Date.now();
      candidates.forEach(cls => {
        const clsInfo = data[cls];
        if (clsInfo && clsInfo.status === 'active' && serverNow - clsInfo.timestamp >= getSlideMs(data)) {
          updates[`${cls}.status`] = 'done';
        }
      });
      if (Object.keys(updates).length > 0) {
        transaction.update(DISMISSAL_DOC_REF, updates);
      }
    });
  } catch (error) {
    console.error('班別過期更新失敗', error);
  } finally {
    expireInFlight = false;
  }
}

// ⏰ 每日自動 Reset 檢查機制
function checkDailyAutoReset(data) {
  const todayStr = getHongKongDateString();
  const lastResetDate = data._lastResetDate || "";

  if (lastResetDate !== todayStr) {
    const resetData = {};
    ALL_CLASSES.forEach(cls => {
      resetData[cls] = { status: 'waiting', timestamp: 0 };
    });
    resetData['_announcement'] = '';
    resetData['_lastResetDate'] = todayStr;
    resetData['_custom_presets'] = data._custom_presets || DEFAULT_PRESETS;
    resetData['_slideMinutes'] = getSlideMinutes(data);

    setDoc(DISMISSAL_DOC_REF, resetData);
    return true;
  }
  return false;
}

// 即時監聽資料庫變更
function initRealtimeListener() {
  onSnapshot(DISMISSAL_DOC_REF, (docSnap) => {
    showLoading(false);
    const newData = docSnap.exists() ? docSnap.data() : {};

    if (isControlPage && isSchoolUser(auth.currentUser) && checkDailyAutoReset(newData)) return;

    ALL_CLASSES.forEach(cls => {
      const newStatus = newData[cls]?.status;
      const oldStatus = previousFirestoreData[cls]?.status;
      if (isDisplayPage && hasLoadedOnce && oldStatus !== 'active' && newStatus === 'active') {
        scheduleClassAnnouncement(cls, newData[cls]?.timestamp);
      }
    });

    if (isDisplayPage && hasLoadedOnce && newData._announcement && newData._announcement !== previousFirestoreData._announcement) {
      isModalClosedByUser = false;
      playDingDong();
      setTimeout(() => {
        speakCantonese(`重要通告：${newData._announcement}`);
      }, 1000);
    }

    currentFirestoreData = newData;
    previousFirestoreData = JSON.parse(JSON.stringify(newData));
    hasLoadedOnce = true;

    checkAndExpireClasses();

    renderDisplayView(currentFirestoreData);
    renderControlView(currentFirestoreData);
    renderNoticeOverlay(currentFirestoreData);
  }, (error) => {
    showLoading(false);
    if (typeof Swal !== 'undefined') {
      Swal.fire({ icon: 'error', title: '連線錯誤', text: error.message });
    }
  });
}

function renderNoticeOverlay(data) {
  const modal = document.getElementById('noticeModal');
  const modalBody = document.getElementById('noticeModalBody');
  if (!modal || !modalBody) return;

  const hasNotice = data._announcement && data._announcement.trim() !== '';

  if (hasNotice && currentView === 'display' && !isModalClosedByUser) {
    modalBody.textContent = data._announcement;
    modal.classList.add('active');
  } else {
    modal.classList.remove('active');
  }
}

// 🎯 核心渲染修正處
function renderDisplayView(data) {
  const activeWrapper = document.getElementById('activeClassesWrapper');
  const gridContainer = document.getElementById('displayClassGrid');
  if (!activeWrapper || !gridContainer) return;

  const activeClasses = [];
  gridContainer.innerHTML = '';

  ALL_CLASSES.forEach(cls => {
    const clsInfo = data[cls] || { status: 'waiting' };
    
    // 1. Slide Show (正在放學班別)：只收集 3分鐘內的班別 (status === 'active')
    if (clsInfo.status === 'active') {
      activeClasses.push(cls);
    }

    // 已放學保持亮起，但不再使用「放學中」的閃動動畫
    let displayStatusClass = 'status-waiting';
    if (clsInfo.status === 'active') displayStatusClass = 'status-active';
    else if (clsInfo.status === 'done') displayStatusClass = 'status-dismissed';

    const item = document.createElement('div');
    const gradeClass = getGradeClass(cls);
    item.className = `status-box ${gradeClass} ${displayStatusClass}`;
    item.innerHTML = `<span class="class-label">${cls}</span>`;
    gridContainer.appendChild(item);
  });

  // 渲染 Slide Show
  if (activeClasses.length === 0) {
    activeWrapper.innerHTML = `<span class="placeholder-text">現時沒有班別放學中</span>`;
  } else if (activeClasses.length <= 5) {
    const badgesHTML = activeClasses.map(cls => {
      const gradeClass = getGradeClass(cls);
      return `<span class="badge-item ${gradeClass}">${cls}</span>`;
    }).join('');

    activeWrapper.innerHTML = `<div class="static-badge-container">${badgesHTML}</div>`;
  } else {
    const badgesHTML = activeClasses.map(cls => {
      const gradeClass = getGradeClass(cls);
      return `<span class="badge-item ${gradeClass}">${cls}</span>`;
    }).join('');

    const seconds = Math.max(36, activeClasses.length * 7);
    activeWrapper.innerHTML = `
      <div class="marquee-track-slideout" style="animation-duration:${seconds}s">
        ${badgesHTML}
      </div>
    `;
  }
}

function updateUndoButton(data) {
  const btn = document.getElementById('btnUndoLast');
  if (!btn) return;
  const last = data._lastAction;
  if (last && last.className) {
    btn.disabled = false;
    btn.textContent = `撤銷 ${last.className}`;
  } else {
    btn.disabled = true;
    btn.textContent = '撤銷上一班';
  }
}

function renderControlView(data) {
  const gridContainer = document.getElementById('controlClassGrid');
  if (!gridContainer) return;
  gridContainer.innerHTML = '';

  ALL_CLASSES.forEach(cls => {
    const clsInfo = data[cls] || { status: 'waiting' };
    const btn = document.createElement('button');
    const gradeClass = getGradeClass(cls);
    
    btn.className = `control-btn ${gradeClass} status-${clsInfo.status}`;
    btn.innerHTML = `<span class="class-label">${cls}</span>`;

    btn.addEventListener('click', () => triggerClassDismissal(cls));
    gridContainer.appendChild(btn);
  });

  const noticeInput = document.getElementById('noticeInput');
  if (noticeInput && document.activeElement !== noticeInput) {
    noticeInput.value = data._announcement || '';
  }

  renderPresetButtons(data._custom_presets || DEFAULT_PRESETS);
  updateUndoButton(data);
  updateSlideMinutesField(data);
}

function updateSlideMinutesField(data) {
  const input = document.getElementById('slideMinutesInput');
  const hint = document.getElementById('slideHint');
  const minutes = getSlideMinutes(data);
  if (hint) hint.textContent = `點擊班別開啟「正在放學」。5 秒內可撤銷，期間大堂不會廣播。${minutes} 分鐘後收起輪播。`;
  if (input && document.activeElement !== input) input.value = String(minutes);
}

async function saveSlideMinutes() {
  const input = document.getElementById('slideMinutesInput');
  const minutes = getSlideMinutes({ _slideMinutes: input ? input.value : 3 });
  if (input) input.value = String(minutes);
  showLoading(true);
  try {
    await updateDoc(DISMISSAL_DOC_REF, { _slideMinutes: minutes });
  } catch (e) {
    await setDoc(DISMISSAL_DOC_REF, { _slideMinutes: minutes }, { merge: true });
  } finally {
    showLoading(false);
  }
}

function renderPresetButtons(presets) {
  const container = document.getElementById('presetButtonsContainer');
  if (!container) return;
  container.innerHTML = '';

  presets.forEach(msg => {
    const btn = document.createElement('button');
    btn.className = 'btn-preset';
    btn.textContent = msg.length > 8 ? msg.substring(0, 8) + '...' : msg;
    btn.title = msg;
    btn.addEventListener('click', () => {
      const input = document.getElementById('noticeInput');
      if (input) input.value = msg;
    });
    container.appendChild(btn);
  });
}

async function managePresets() {
  if (typeof Swal === 'undefined') return;

  const currentPresets = currentFirestoreData._custom_presets || DEFAULT_PRESETS;
  
  let listHTML = currentPresets.map((p, index) => `
    <div style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
      <input type="text" id="preset_input_${index}" value="${escapeHtml(p)}" class="swal2-input" style="margin: 0; flex: 1; font-size: 14px;">
      <button class="swal2-cancel swal2-styled" onclick="document.getElementById('preset_input_${index}').parentElement.remove()" style="background:#ef4444; margin:0; padding:6px 10px;">刪除</button>
    </div>
  `).join('');

  const { value: formValues } = await Swal.fire({
    title: '⚙️ 管理快捷範本',
    html: `
      <div id="presetInputsWrapper" style="max-height: 250px; overflow-y: auto; text-align: left; padding: 4px;">
        ${listHTML}
      </div>
      <button type="button" id="btnAddMorePreset" class="swal2-confirm swal2-styled" style="background:#10b981; margin-top:10px;">+ 新增範本</button>
    `,
    showCancelButton: true,
    confirmButtonText: '儲存變更',
    cancelButtonText: '取消',
    didOpen: () => {
      document.getElementById('btnAddMorePreset')?.addEventListener('click', () => {
        const wrapper = document.getElementById('presetInputsWrapper');
        const newDiv = document.createElement('div');
        newDiv.style.cssText = "display: flex; gap: 8px; margin-bottom: 8px; align-items: center;";
        newDiv.innerHTML = `
          <input type="text" class="swal2-input preset-new-item" placeholder="輸入常用通告內容" style="margin: 0; flex: 1; font-size: 14px;">
          <button class="swal2-cancel swal2-styled" onclick="this.parentElement.remove()" style="background:#ef4444; margin:0; padding:6px 10px;">刪除</button>
        `;
        wrapper.appendChild(newDiv);
      });
    },
    preConfirm: () => {
      const inputs = document.querySelectorAll('#presetInputsWrapper input');
      const updatedPresets = [];
      inputs.forEach(input => {
        const val = input.value.trim();
        if (val) updatedPresets.push(val);
      });
      return updatedPresets;
    }
  });

  if (formValues) {
    showLoading(true);
    try {
      await updateDoc(DISMISSAL_DOC_REF, { _custom_presets: formValues });
      Swal.fire('已更新！', '快捷範本設定已成功儲存。', 'success');
    } catch (e) {
      await setDoc(DISMISSAL_DOC_REF, { _custom_presets: formValues }, { merge: true });
    } finally {
      showLoading(false);
    }
  }
}

async function publishNotice() {
  const input = document.getElementById('noticeInput');
  const msg = input ? input.value.trim() : '';
  if (!msg) {
    if (typeof Swal !== 'undefined') Swal.fire('請輸入通告內容', '', 'info');
    return;
  }

  showLoading(true);
  try {
    await updateDoc(DISMISSAL_DOC_REF, { _announcement: msg });
  } catch (e) {
    await setDoc(DISMISSAL_DOC_REF, { _announcement: msg }, { merge: true });
  } finally {
    showLoading(false);
  }
}

async function clearNotice() {
  showLoading(true);
  try {
    await updateDoc(DISMISSAL_DOC_REF, { _announcement: '' });
    const input = document.getElementById('noticeInput');
    if (input) input.value = '';
  } catch (e) {
    console.error(e);
  } finally {
    showLoading(false);
  }
}

async function triggerClassDismissal(className) {
  const previous = currentFirestoreData[className] || { status: 'waiting', timestamp: 0 };
  const timestamp = Date.now();
  const payload = {
    [`${className}.status`]: 'active',
    [`${className}.timestamp`]: timestamp,
    _lastAction: {
      className,
      status: previous.status || 'waiting',
      timestamp: previous.timestamp || 0
    }
  };
  try {
    showLoading(true);
    await updateDoc(DISMISSAL_DOC_REF, payload);
  } catch (e) {
    const initialData = {
      [className]: { status: 'active', timestamp },
      _lastAction: payload._lastAction
    };
    await setDoc(DISMISSAL_DOC_REF, initialData, { merge: true });
  } finally {
    showLoading(false);
  }
}

async function undoLastDismissal() {
  const last = currentFirestoreData._lastAction;
  if (!last || !last.className) {
    if (typeof Swal !== 'undefined') Swal.fire('沒有可撤銷的操作', '', 'info');
    return;
  }
  showLoading(true);
  try {
    await updateDoc(DISMISSAL_DOC_REF, {
      [`${last.className}.status`]: last.status || 'waiting',
      [`${last.className}.timestamp`]: last.timestamp || 0,
      _lastAction: deleteField()
    });
  } catch (e) {
    console.error(e);
    if (typeof Swal !== 'undefined') Swal.fire('撤銷失敗', '請確認已用學校帳戶登入。', 'error');
  } finally {
    showLoading(false);
  }
}

async function resetAllClasses() {
  if (typeof Swal !== 'undefined') {
    const result = await Swal.fire({
      title: '確定重置所有班別？',
      text: '此操作會將所有班別恢復為預設狀態。',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: '確定重置',
      cancelButtonText: '取消'
    });

    if (result.isConfirmed) {
      showLoading(true);
      const resetData = {};
      const todayStr = getHongKongDateString();
      ALL_CLASSES.forEach(cls => {
        resetData[cls] = { status: 'waiting', timestamp: 0 };
      });
      resetData['_announcement'] = '';
      resetData['_lastResetDate'] = todayStr;
      resetData['_lastAction'] = deleteField();
      await setDoc(DISMISSAL_DOC_REF, resetData, { merge: true });
      showLoading(false);
      Swal.fire('已重置！', '所有班別及通告已清空。', 'success');
    }
  }
}

function usesRedirectSignIn() {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  return mobile || coarse;
}

function describeAuthError(error) {
  if (!error || error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') return "";
  const detail = `${error.code || ""} ${error.message || ""}`;
  if (/missing initial state/i.test(detail)) {
    return "手機瀏覽器未能完成上一次登入。請再按一次登入。";
  }
  if (error.code === 'auth/popup-blocked') {
    return "瀏覽器擋住了登入視窗，請允許彈出式視窗後再試。";
  }
  if (error.code === 'auth/unauthorized-domain') {
    return "這個網址未獲授權。請在 Firebase Authentication 的授權網域加入 taikoo-dismissal-system.web.app。";
  }
  if (
    error.code === 'auth/operation-not-allowed' ||
    /requested action is invalid|CONFIGURATION_NOT_FOUND|configuration-not-found/i.test(detail)
  ) {
    return "Firebase 尚未開啟 Google 登入。請到 Authentication 按「開始使用」，再啟用 Google 登入方式。";
  }
  return "登入失敗，請再試一次。";
}

function createSchoolProvider() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: SCHOOL_DOMAIN, prompt: 'select_account' });
  return provider;
}

function setupControlAuth() {
  if (location.hostname === "taikoo-dismissal-system.web.app") {
    location.replace(`https://taikoo-dismissal-system.firebaseapp.com${location.pathname}${location.search}${location.hash}`);
    return;
  }

  const errorEl = document.getElementById('authError');

  getRedirectResult(auth).then(async (result) => {
    if (result?.user && !isSchoolUser(result.user)) {
      await signOut(auth);
      if (errorEl) errorEl.textContent = '只接受 @tps.edu.hk 的學校 Google 帳戶。';
    }
  }).catch((error) => {
    const text = describeAuthError(error);
    if (text && errorEl) errorEl.textContent = text;
    console.error(error);
  });

  document.getElementById('btnGoogleLogin')?.addEventListener('click', async () => {
    if (errorEl) errorEl.textContent = '';
    try {
      if (usesRedirectSignIn()) {
        await signInWithRedirect(auth, createSchoolProvider());
        return;
      }
      const result = await signInWithPopup(auth, createSchoolProvider());
      if (result && !isSchoolUser(result.user)) {
        await signOut(auth);
        if (errorEl) errorEl.textContent = '只接受 @tps.edu.hk 的學校 Google 帳戶。';
      }
    } catch (error) {
      const text = describeAuthError(error);
      if (text && errorEl) errorEl.textContent = text;
      console.error(error);
    }
  });

  document.getElementById('btnLogout')?.addEventListener('click', () => signOut(auth));

  onAuthStateChanged(auth, (user) => {
    if (!isSchoolUser(user)) {
      document.body.classList.add('control-locked');
      document.body.classList.remove('control-ready');
      if (user) signOut(auth);
      return;
    }
    document.body.classList.remove('control-locked');
    document.body.classList.add('control-ready');
    const who = document.getElementById('signedInAs');
    if (who) who.textContent = user.email;
    if (!listenerStarted) {
      listenerStarted = true;
      showLoading(true);
      initRealtimeListener();
    }
  });
}

if (isDisplayPage) {
  setupDisplayAudioShortcut();
  showLoading(true);
  listenerStarted = true;
  initRealtimeListener();
} else if (isControlPage) {
  setupControlAuth();
}