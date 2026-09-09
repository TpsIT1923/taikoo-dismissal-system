import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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

// 語音廣播對列
let speechQueue = [];
let isSpeaking = false;

function getGradeClass(className) {
  return `p${className.charAt(0)}`;
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

// 🔊 語音與音效系統
function initAudioSystem() {
  const btnToggleAudio = document.getElementById('btnToggleAudio');
  if (!btnToggleAudio) return;

  btnToggleAudio.addEventListener('click', () => {
    isAudioEnabled = !isAudioEnabled;
    if (isAudioEnabled) {
      btnToggleAudio.textContent = "🔊 語音廣播已開啟";
      btnToggleAudio.classList.remove('muted');
      btnToggleAudio.classList.add('active');
      speakCantonese("語音廣播系統已開啟");
    } else {
      btnToggleAudio.textContent = "🔇 點擊開啟語音廣播";
      btnToggleAudio.classList.remove('active');
      btnToggleAudio.classList.add('muted');
      window.speechSynthesis.cancel();
    }
  });
}

// 播放叮噹提示音 (使用 Web Audio API 生成純正叮噹聲)
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
  if (isSpeaking || speechQueue.length === 0) return;

  isSpeaking = true;
  const textToSpeak = speechQueue.shift();
  const utterance = new SpeechSynthesisUtterance(textToSpeak);
  
  utterance.lang = 'zh-HK'; // 廣東話
  utterance.rate = 0.9;     // 稍微放慢語速，讓大螢幕廣播更清楚

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

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnShowDisplay')?.addEventListener('click', () => switchView('display'));
  document.getElementById('btnShowControl')?.addEventListener('click', () => switchView('control'));
  document.getElementById('btnResetAll')?.addEventListener('click', resetAllClasses);

  document.getElementById('btnPublishNotice')?.addEventListener('click', publishNotice);
  document.getElementById('btnClearNotice')?.addEventListener('click', clearNotice);
  document.getElementById('btnManagePresets')?.addEventListener('click', managePresets);

  document.getElementById('btnCloseNoticeModal')?.addEventListener('click', () => {
    isModalClosedByUser = true;
    const modal = document.getElementById('noticeModal');
    if (modal) modal.classList.remove('active');
  });

  initAudioSystem();
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

function checkAndExpireClasses() {
  if (!currentFirestoreData) return;
  const now = Date.now();
  let needUpdateDb = false;

  ALL_CLASSES.forEach(cls => {
    const clsInfo = currentFirestoreData[cls];
    if (clsInfo && clsInfo.status === 'active') {
      if (now - clsInfo.timestamp >= THREE_MINUTES_MS) {
        clsInfo.status = 'done';
        needUpdateDb = true;
      }
    }
  });

  if (needUpdateDb) {
    updateDoc(DISMISSAL_DOC_REF, currentFirestoreData);
    renderDisplayView(currentFirestoreData);
    renderControlView(currentFirestoreData);
  }
}

// ⏰ 每日自動 Reset 檢查機制
function checkDailyAutoReset(data) {
  const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const lastResetDate = data._lastResetDate || "";

  if (lastResetDate !== todayStr) {
    // 發現是新的一天，自動進行重置
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

    // 1. 檢查是否需要每日自動 Reset
    if (checkDailyAutoReset(newData)) return;

    // 2. 檢測是否有新班別開始放學，觸發語音廣播
    ALL_CLASSES.forEach(cls => {
      const oldStatus = previousFirestoreData[cls]?.status;
      const newStatus = newData[cls]?.status;

      if (oldStatus !== 'active' && newStatus === 'active') {
        const gradeLetter = cls.charAt(1);
        const gradeNum = cls.charAt(0);
        speakCantonese(`請 ${gradeNum} ${gradeLetter} 班家長準備，你嘅小朋友放學啦！`);
      }
    });

    // 3. 檢測是否有新重要通告，觸發叮噹聲與語音
    if (newData._announcement && newData._announcement !== previousFirestoreData._announcement) {
      isModalClosedByUser = false;
      playDingDong();
      setTimeout(() => {
        speakCantonese(`重要通告：${newData._announcement}`);
      }, 1000);
    }

    currentFirestoreData = newData;
    previousFirestoreData = JSON.parse(JSON.stringify(newData));

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

function renderDisplayView(data) {
  const activeWrapper = document.getElementById('activeClassesWrapper');
  const gridContainer = document.getElementById('displayClassGrid');

  const activeClasses = [];
  gridContainer.innerHTML = '';

  ALL_CLASSES.forEach(cls => {
    const clsInfo = data[cls] || { status: 'waiting' };
    if (clsInfo.status === 'active') {
      activeClasses.push(cls);
    }

    const item = document.createElement('div');
    const gradeClass = getGradeClass(cls);
    item.className = `status-box ${gradeClass} status-${clsInfo.status}`;
    item.textContent = cls;
    gridContainer.appendChild(item);
  });

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

function renderControlView(data) {
  const gridContainer = document.getElementById('controlClassGrid');
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
      <input type="text" id="preset_input_${index}" value="${p}" class="swal2-input" style="margin: 0; flex: 1; font-size: 14px;">
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
  try {
    showLoading(true);
    await updateDoc(DISMISSAL_DOC_REF, {
      [`${className}.status`]: 'active',
      [`${className}.timestamp`]: Date.now()
    });
  } catch (e) {
    const initialData = {};
    initialData[className] = { status: 'active', timestamp: Date.now() };
    await setDoc(DISMISSAL_DOC_REF, initialData, { merge: true });
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
      const todayStr = new Date().toISOString().split('T')[0];
      ALL_CLASSES.forEach(cls => {
        resetData[cls] = { status: 'waiting', timestamp: 0 };
      });
      resetData['_announcement'] = '';
      resetData['_lastResetDate'] = todayStr;
      await setDoc(DISMISSAL_DOC_REF, resetData, { merge: true });
      showLoading(false);
      Swal.fire('已重置！', '所有班別及通告已清空。', 'success');
    }
  }
}

showLoading(true);
initRealtimeListener();