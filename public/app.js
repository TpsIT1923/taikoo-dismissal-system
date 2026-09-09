import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, onSnapshot, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// 1. 太古小學專屬 Firebase Config 設定
const firebaseConfig = {
  apiKey: "AIzaSyCYndV2aTf1KEB6yBgjjhOoUIqUKf3jsJY",
  authDomain: "taikoo-dismissal-system.firebaseapp.com",
  projectId: "taikoo-dismissal-system",
  storageBucket: "taikoo-dismissal-system.firebasestorage.app",
  messagingSenderId: "881254467284",
  appId: "1:881254467284:web:b56a348000ce78a0fc5d41",
  measurementId: "G-64B89N4NQJ"
};

// 初始化 Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 定義全校 1A 至 6E 班別
const ALL_CLASSES = [
  "1A", "1B", "1C", "1D", "1E",
  "2A", "2B", "2C", "2D", "2E",
  "3A", "3B", "3C", "3D", "3E",
  "4A", "4B", "4C", "4D", "4E",
  "5A", "5B", "5C", "5D", "5E",
  "6A", "6B", "6C", "6D", "6E"
];

const DISMISSAL_DOC_REF = doc(db, "dismissal_system", "live_status");
const THREE_MINUTES_MS = 3 * 60 * 1000; // 3分鐘倒數時間

// 2. 視圖切換
window.switchView = function(viewName) {
  document.getElementById('displayView').classList.remove('active');
  document.getElementById('controlView').classList.remove('active');
  document.getElementById('btnShowDisplay').classList.remove('active');
  document.getElementById('btnShowControl').classList.remove('active');

  if (viewName === 'display') {
    document.getElementById('displayView').classList.add('active');
    document.getElementById('btnShowDisplay').classList.add('active');
  } else {
    document.getElementById('controlView').classList.add('active');
    document.getElementById('btnShowControl').classList.add('active');
  }
};

function showLoading(show) {
  const overlay = document.getElementById('loadingOverlay');
  overlay.style.display = show ? 'flex' : 'none';
}

// 3. Realtime 即時資料數據同步
function initRealtimeListener() {
  onSnapshot(DISMISSAL_DOC_REF, (docSnap) => {
    showLoading(false);
    let data = docSnap.exists() ? docSnap.data() : {};

    const now = Date.now();
    let hasUpdates = false;

    // 檢查「正在放學」班別是否已滿 3 分鐘
    ALL_CLASSES.forEach(cls => {
      if (data[cls] && data[cls].status === 'active') {
        if (now - data[cls].timestamp >= THREE_MINUTES_MS) {
          data[cls].status = 'done';
          hasUpdates = true;
        }
      }
    });

    if (hasUpdates) {
      updateDoc(DISMISSAL_DOC_REF, data);
    }

    renderDisplayView(data);
    renderControlView(data);
  }, (error) => {
    showLoading(false);
    Swal.fire({ icon: 'error', title: '連線錯誤', text: error.message });
  });
}

// 渲染大螢幕展示屏
function renderDisplayView(data) {
  const activeContainer = document.getElementById('activeClassesList');
  const gridContainer = document.getElementById('displayClassGrid');

  const activeClasses = [];
  gridContainer.innerHTML = '';

  ALL_CLASSES.forEach(cls => {
    const clsInfo = data[cls] || { status: 'waiting' };
    if (clsInfo.status === 'active') {
      activeClasses.push(cls);
    }

    const item = document.createElement('div');
    item.className = `status-item status-${clsInfo.status}`;
    item.textContent = cls;
    gridContainer.appendChild(item);
  });

  // 渲染正在放學班別 (流水滑動效果)
  if (activeClasses.length > 0) {
    activeContainer.innerHTML = activeClasses
      .map(cls => `<span class="class-badge-large">${cls}</span>`)
      .join('');
  } else {
    activeContainer.innerHTML = `<span class="placeholder-text">現時沒有班別放學中</span>`;
  }
}

// 渲染地下控制台
function renderControlView(data) {
  const gridContainer = document.getElementById('controlClassGrid');
  gridContainer.innerHTML = '';

  ALL_CLASSES.forEach(cls => {
    const clsInfo = data[cls] || { status: 'waiting' };
    const btn = document.createElement('button');
    btn.className = `class-btn status-${clsInfo.status}`;
    btn.textContent = cls;

    btn.onclick = () => triggerClassDismissal(cls);
    gridContainer.appendChild(btn);
  });
}

// 4. 控制台觸發動作
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

// 重置所有班別
window.resetAllClasses = async function() {
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
    ALL_CLASSES.forEach(cls => {
      resetData[cls] = { status: 'waiting', timestamp: 0 };
    });
    await setDoc(DISMISSAL_DOC_REF, resetData);
    showLoading(false);
    Swal.fire('已重置！', '所有班別狀態已清空。', 'success');
  }
};

// 定時巡檢機制 (每 10 秒檢查過期時間)
setInterval(() => {
  initRealtimeListener();
}, 10000);

showLoading(true);
initRealtimeListener();