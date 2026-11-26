const joinPanel = document.getElementById('join-panel');
const roomPanel = document.getElementById('room-panel');
const joinForm = document.getElementById('join-form');
const joinButton = document.getElementById('join-button');
const joinError = document.getElementById('join-error');
const micButton = document.getElementById('mic-button');
const leaveButton = document.getElementById('leave-button');
const volume = document.getElementById('volume');
const volumeValue = document.getElementById('volume-value');
const participants = document.getElementById('participants');
const participantCount = document.getElementById('participant-count');
const connectionState = document.getElementById('connection-state');

let socket = null;
let stream = null;
let audioContext = null;
let worklet = null;
let gainNode = null;
let muted = false;

function showError(message) {
  joinError.textContent = message || '';
}
function setConnectionState(message) {
  connectionState.textContent = message;
}
function renderParticipants(items) {
  participants.replaceChildren();
  for (const person of items || []) {
    const li = document.createElement('li');
    li.textContent = person.name + (person.source === 'discord' ? '（Discord）' : '');
    if (person.source === 'guest') li.classList.add('guest');
    participants.appendChild(li);
  }
  participantCount.textContent = String((items || []).length);
}
function cleanup() {
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  worklet = null;
  gainNode = null;
  muted = false;
  micButton.textContent = 'マイクをミュート';
  roomPanel.hidden = true;
  joinPanel.hidden = false;
}
async function connectAudio(token) {
  audioContext = new AudioContext({ sampleRate: 48000 });
  await audioContext.audioWorklet.addModule('/audio-worklet.js');
  const source = audioContext.createMediaStreamSource(stream);
  worklet = new AudioWorkletNode(audioContext, 'voice-bridge-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1
  });
  gainNode = audioContext.createGain();
  gainNode.gain.value = Number(volume.value) / 100;
  worklet.port.onmessage = event => {
    if (event.data?.type === 'mic' && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(event.data.buffer);
    }
  };
  source.connect(worklet);
  worklet.connect(gainNode);
  gainNode.connect(audioContext.destination);
  await audioContext.resume();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(protocol + '//' + location.host + '/ws?token=' + encodeURIComponent(token));
  socket.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('音声サーバーへの接続がタイムアウトしました。')), 12000);
    socket.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('音声サーバーに接続できませんでした。'));
    };
  });
  socket.onmessage = event => {
    if (typeof event.data === 'string') {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'participants') renderParticipants(message.participants);
      if (message.type === 'closed') {
        setConnectionState(message.reason || '接続が終了しました');
        setTimeout(cleanup, 1200);
      }
      return;
    }
    if (worklet && event.data instanceof ArrayBuffer) {
      worklet.port.postMessage({ type: 'play', buffer: event.data }, [event.data]);
    }
  };
  socket.onclose = () => {
    if (!roomPanel.hidden) setConnectionState('接続が切断されました');
  };
}

joinForm.addEventListener('submit', async event => {
  event.preventDefault();
  showError('');
  joinButton.disabled = true;
  joinButton.textContent = '接続中…';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザではマイクを利用できません。HTTPSで開いてください。');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    const response = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('guest-name').value,
        code: document.getElementById('guest-code').value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '参加できませんでした。');
    await connectAudio(result.token);
    document.getElementById('channel-name').textContent = result.channelName;
    joinPanel.hidden = true;
    roomPanel.hidden = false;
    setConnectionState('接続中');
  } catch (error) {
    cleanup();
    showError(error.message || '接続に失敗しました。');
  } finally {
    joinButton.disabled = false;
    joinButton.textContent = '参加する';
  }
});

micButton.addEventListener('click', () => {
  muted = !muted;
  if (stream) for (const track of stream.getAudioTracks()) track.enabled = !muted;
  micButton.textContent = muted ? 'マイクをオンにする' : 'マイクをミュート';
});
leaveButton.addEventListener('click', cleanup);
volume.addEventListener('input', () => {
  const value = Number(volume.value);
  volumeValue.textContent = value + '%';
  if (gainNode) gainNode.gain.value = value / 100;
});
window.addEventListener('pagehide', cleanup);