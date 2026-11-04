import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc, updateDoc, runTransaction, deleteField } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

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
const THREE_MINUTES_MS = 3 * 60 * 1000;

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
  const label = document.getElementById('audioState');
  if (!label) return;
  label.textContent = isAudioEnabled ? "廣播已開啟" : "廣播未開啟";
  label.classList.toggle('is-on', isAudioEnabled);
}

function setupDisplayAudioShortcut() {
  paintAudioState();
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's')) return;
    event.preventDefault();
    isAudioEnabled = !isAudioEnabled;
    if (isAudioEnabled) {
      speakCantonese("語音廣播系統已開啟");
    } else {
      window.speechSynthesis?.cancel();
      speechQueue = [];
      isSpeaking = false;
    }
    paintAudioState();
  });
}

function playTestAnnouncement() {
  if (!('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance("語音試聽。請 1 A 班家長準備，你嘅小朋友放學啦！");
  utterance.lang = 'zh-HK';
  utterance.rate = 0.88;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
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
  if (!isAudioEnabled || !('speechSynthesis' in window)) return;

  speechQueue.push(text);
  processSpeechQueue();
}

function processSpeechQueue() {
  if (!isAudioEnabled) {
    speechQueue = [];
    isSpeaking = false;
    return;
  }
  if (isSpeaking || speechQueue.length === 0) return;

  isSpeaking = true;
  const textToSpeak = speechQueue.shift();
  const utterance = new SpeechSynthesisUtterance(textToSpeak);
  
  utterance.lang = 'zh-HK'; // 廣東話
  utterance.rate = 0.88;    // 保持清晰自然語速

  utterance.onend = () => {
    isSpeaking = false;
    processSpeechQueue();
  };

  utterance.onerror = () => {
    isSpeaking = false;
    processSpeechQueue();
  };

  window.speechSynthesis.speak(utterance);
}

function scheduleClassAnnouncement(className, timestamp) {
  const existing = pendingAnnouncements.get(className);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingAnnouncements.delete(className);
    const info = currentFirestoreData[className];
    if (info && info.status === 'active' && info.timestamp === timestamp) {
      speakCantonese(getDismissalAnnouncement(className));
    }
  }, ANNOUNCE_DELAY_MS);
  pendingAnnouncements.set(className, timer);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnResetAll')?.addEventListener('click', resetAllClasses);
  document.getElementById('btnUndoLast')?.addEventListener('click', undoLastDismissal);
  document.getElementById('btnTestSound')?.addEventListener('click', playTestAnnouncement);
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
    return clsInfo && clsInfo.status === 'active' && now - clsInfo.timestamp >= THREE_MINUTES_MS;
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
        if (clsInfo && clsInfo.status === 'active' && serverNow - clsInfo.timestamp >= THREE_MINUTES_MS) {
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
    item.textContent = cls;
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

    activeWrapper.innerHTML = `
      <div class="marquee-track-slideout">
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
    btn.textContent = cls;

    btn.addEventListener('click', () => triggerClassDismissal(cls));
    gridContainer.appendChild(btn);
  });

  const noticeInput = document.getElementById('noticeInput');
  if (noticeInput && document.activeElement !== noticeInput) {
    noticeInput.value = data._announcement || '';
  }

  renderPresetButtons(data._custom_presets || DEFAULT_PRESETS);
  updateUndoButton(data);
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

function setupControlAuth() {
  const errorEl = document.getElementById('authError');
  document.getElementById('btnGoogleLogin')?.addEventListener('click', async () => {
    if (errorEl) errorEl.textContent = '';
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ hd: SCHOOL_DOMAIN, prompt: 'select_account' });
    try {
      const result = await signInWithPopup(auth, provider);
      if (!isSchoolUser(result.user)) {
        await signOut(auth);
        if (errorEl) errorEl.textContent = '只接受 @tps.edu.hk 的學校 Google 帳戶。';
      }
    } catch (error) {
      if (error.code === 'auth/popup-closed-by-user') return;
      if (errorEl) {
        errorEl.textContent = error.code === 'auth/operation-not-allowed'
          ? 'Firebase 尚未啟用 Google 登入，請先在 Authentication 開啟 Google。'
          : '登入失敗，請再試一次。';
      }
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