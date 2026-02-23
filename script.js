import { openaiConfig } from "https://cdn.jsdelivr.net/npm/bootstrap-llm-provider@1.2";
import { bootstrapAlert } from "https://cdn.jsdelivr.net/npm/bootstrap-alert@1";

const APP_STATE = {
  apiKey: null, baseUrl: 'https://api.openai.com/v1', model: 'gpt-realtime-mini', qaModel: 'gpt-4o',
  micStream: null, speakerStream: null, micSocket: null, speakerSocket: null,
  audioContext: null, micProcessor: null, speakerProcessor: null,
  micSessionId: null, speakerSessionId: null,
  transcript: { segments: [] },
  summaryInterval: null, lastCustomerSpeechTime: null, enableSummary: false, enableSuggestions: false,
  processingCustomerSuggestion: false
};

const $ = id => document.getElementById(id);
const escapeHtml = text => { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; };
const getTranscriptText = () => APP_STATE.transcript.segments.map(s => `${s.channel === 'mic' ? 'AGENT' : 'CUSTOMER'}: ${s.text}`).join('\n');

class Logger {
  static log(msg, type = 'info') {
    const log = $('logConsole');
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
    console[type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'log'](msg);
  }
  static info(m) { this.log(m, 'info'); }
  static success(m) { this.log(m, 'success'); }
  static warn(m) { this.log(m, 'warn'); }
  static error(m) { this.log(m, 'error'); }
}

async function initLLM(show = false) {
  try {
    const cfg = await openaiConfig({ title: 'OpenAI Configuration for Call Center Copilot', defaultBaseUrls: ['https://api.openai.com/v1', 'https://openrouter.ai/api/v1'], show });
    APP_STATE.apiKey = cfg.apiKey;
    APP_STATE.baseUrl = cfg.baseUrl;
    Logger.success('OpenAI configured successfully');
  } catch (e) {
    bootstrapAlert({ body: `Failed to configure OpenAI: ${e.message}`, color: 'danger' });
    Logger.error(`OpenAI config failed: ${e.message}`);
  }
}

async function getAuthToken() {
  if (!APP_STATE.apiKey) await initLLM();
  if (!APP_STATE.apiKey) throw new Error('No API key available. Please configure OpenAI.');
  return APP_STATE.apiKey;
}

function checkBrowserCompatibility() {
  const checks = [
    [navigator.mediaDevices?.getUserMedia, 'getUserMedia not supported - microphone capture will not work'],
    [navigator.mediaDevices?.getDisplayMedia, 'getDisplayMedia not supported - speaker/tab capture will not work'],
    [window.WebSocket, 'WebSocket not supported - real-time API connection will not work'],
    [window.AudioContext || window.webkitAudioContext, 'AudioContext not supported - audio processing will not work']
  ];
  const issues = checks.filter(([check]) => !check).map(([, msg]) => msg);
  if (issues.length > 0) {
    Logger.error('Browser compatibility issues detected:');
    issues.forEach(issue => Logger.error(`  - ${issue}`));
    Logger.warn('Recommended browsers: Chrome 94+, Edge 94+, Firefox 93+');
    bootstrapAlert({ body: '⚠️ Browser Compatibility Warning: ' + issues.join('; ') + '. Please use a modern browser (Chrome, Edge, or Firefox).', color: 'warning' });
    return false;
  }
  Logger.success('Browser compatibility check passed');
  return true;
}

async function startMicCapture() {
  try {
    Logger.info('Requesting microphone access...');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 24000 } });
    APP_STATE.micStream = stream;
    updateStatus('mic', 'Captured', 'warning');
    Logger.success('Microphone captured successfully');
    await connectRealtimeAPI('mic', stream);
    return stream;
  } catch (error) {
    Logger.error(`Mic capture failed: ${error.message}`);
    updateStatus('mic', 'Error', 'danger');
    bootstrapAlert({ body: `Mic capture failed: ${error.message}`, color: 'danger' });
    throw error;
  }
}

async function startSpeakerCapture() {
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('getDisplayMedia not supported in this browser. Try Chrome, Edge, or Firefox.');
    Logger.info('Requesting speaker/tab audio capture...');
    Logger.warn('IMPORTANT: Select your Google Meet tab/window and enable "Share audio" checkbox');
    bootstrapAlert({ body: '📢 Important: Select your Google Meet tab and check "Share tab audio" or "Share system audio"', color: 'info' });
    
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: { width: 1, height: 1, frameRate: 1 } });
    } catch (e1) {
      Logger.warn('First attempt failed, trying audio-only request...');
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
    }
    
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('No audio track in captured stream. Make sure to enable "Share tab audio" or "Share system audio" checkbox in the browser dialog.');
    }
    
    stream.getVideoTracks().forEach(track => { track.stop(); stream.removeTrack(track); });
    Logger.success(`Speaker audio captured successfully (${audioTracks.length} audio track(s))`);
    APP_STATE.speakerStream = stream;
    updateStatus('speaker', 'Captured', 'warning');
    audioTracks[0].addEventListener('ended', () => { Logger.warn('Speaker capture ended by user'); stopChannel('speaker'); });
    await connectRealtimeAPI('speaker', stream);
    return stream;
  } catch (error) {
    Logger.error(`Speaker capture failed: ${error.message}`);
    updateStatus('speaker', 'Error', 'danger');
    const errorMsgs = {
      NotAllowedError: 'Screen sharing was denied. Please click "Start Speaker" again and allow screen sharing, then check "Share audio".',
      NotSupportedError: 'Screen audio capture is not supported in this browser. Please use Chrome, Edge (Chromium), or Firefox.',
      NotFoundError: 'No audio source found. Make sure to check "Share tab audio" or "Share system audio" in the screen sharing dialog.'
    };
    bootstrapAlert({ body: errorMsgs[error.name] || `Speaker capture failed: ${error.message}`, color: errorMsgs[error.name] ? 'warning' : 'danger' });
    throw error;
  }
}

async function connectRealtimeAPI(channel, mediaStream) {
  try {
    const token = await getAuthToken();
    Logger.info(`Connecting ${channel} to OpenAI Realtime API...`);
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${APP_STATE.model}`, ['realtime', `openai-insecure-api-key.${token}`, 'openai-beta.realtime-v1']);
    ws.binaryType = 'arraybuffer';
    
    ws.onopen = () => {
      Logger.success(`${channel} WebSocket connected`);
      updateStatus(channel, 'Connected', 'success');
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: `You are transcribing the ${channel === 'mic' ? "call center agent's" : "customer's"} voice. Provide accurate transcription.`,
          voice: 'alloy', input_audio_format: 'pcm16', output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
          temperature: 0.8
        }
      }));
      Logger.info(`${channel} session configured`);
      startAudioStreaming(channel, mediaStream, ws);
    };
    
    ws.onmessage = e => handleRealtimeEvent(channel, JSON.parse(e.data));
    ws.onerror = e => { Logger.error(`${channel} WebSocket error: ${e.message || 'Unknown error'}`); updateStatus(channel, 'Error', 'danger'); };
    ws.onclose = () => { Logger.warn(`${channel} WebSocket closed`); updateStatus(channel, 'Disconnected', 'secondary'); };
    
    APP_STATE[`${channel}Socket`] = ws;
  } catch (error) {
    Logger.error(`Failed to connect ${channel}: ${error.message}`);
    updateStatus(channel, 'Error', 'danger');
    bootstrapAlert({ body: `Failed to connect ${channel}: ${error.message}`, color: 'danger' });
    throw error;
  }
}

function startAudioStreaming(channel, mediaStream, ws) {
  if (!APP_STATE.audioContext) APP_STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  const source = APP_STATE.audioContext.createMediaStreamSource(mediaStream);
  const processor = APP_STATE.audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = e => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: arrayBufferToBase64(convertToPCM16(e.inputBuffer.getChannelData(0))) }));
  };
  source.connect(processor);
  processor.connect(APP_STATE.audioContext.destination);
  APP_STATE[`${channel}Processor`] = processor;
  Logger.info(`${channel} audio streaming started`);
}

const convertToPCM16 = float32Array => {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcm16.buffer;
};

const arrayBufferToBase64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)));

function handleRealtimeEvent(channel, event) {
  const { type } = event;
  if (!type.includes('input_audio_buffer')) Logger.info(`${channel}: ${type}`);
  
  const handlers = {
    'session.created': () => { APP_STATE[`${channel}SessionId`] = event.session.id; Logger.success(`${channel} session created: ${event.session.id}`); },
    'session.updated': () => Logger.success(`${channel} session updated`),
    'conversation.item.input_audio_transcription.completed': () => handleTranscription(channel, event, true),
    'conversation.item.input_audio_transcription.failed': () => Logger.error(`${channel} transcription failed: ${event.error?.message}`),
    'input_audio_buffer.speech_started': () => { Logger.info(`${channel} speech started`); updateStatus(channel, 'Speaking...', 'info'); },
    'input_audio_buffer.speech_stopped': () => {
      Logger.info(`${channel} speech stopped`);
      updateStatus(channel, 'Connected', 'success');
      const ws = APP_STATE[`${channel}Socket`];
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      if (channel === 'speaker' && APP_STATE.enableSuggestions) {
        APP_STATE.lastCustomerSpeechTime = Date.now();
        setTimeout(() => generateCustomerSuggestions(), 1000);
      }
    },
    'error': () => { Logger.error(`${channel} error: ${event.error?.message}`); bootstrapAlert({ body: `${channel} error: ${event.error?.message}`, color: 'danger' }); }
  };
  
  handlers[type]?.();
}

function handleTranscription(channel, event, isFinal) {
  if (!event.transcript?.trim()) return;
  const segment = { channel, ts: new Date().toISOString(), text: event.transcript, item_id: event.item_id, final: isFinal };
  APP_STATE.transcript.segments.push(segment);
  displayTranscriptSegment(segment);
  Logger.success(`${channel} transcription: "${event.transcript}"`);
}

function displayTranscriptSegment(segment) {
  const container = $(`${segment.channel}Transcript`);
  const line = document.createElement('div');
  line.className = `transcript-line ${segment.channel} ${segment.final ? 'final' : 'partial'}`;
  line.dataset.itemId = segment.item_id;
  line.innerHTML = `<span class="timestamp">${new Date(segment.ts).toLocaleTimeString()}</span><span class="text">${escapeHtml(segment.text)}</span>`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

function clearTranscript(channel) {
  if (channel === 'all') {
    APP_STATE.transcript.segments = [];
    $('micTranscript').innerHTML = $('speakerTranscript').innerHTML = '';
  } else {
    APP_STATE.transcript.segments = APP_STATE.transcript.segments.filter(s => s.channel !== channel);
    $(`${channel}Transcript`).innerHTML = '';
  }
  Logger.info(`Cleared ${channel} transcript`);
}

async function askQuestion(question) {
  if (!question.trim()) return Logger.warn('Question is empty');
  Logger.info('Processing Q&A request...');
  displayQAMessage(question, 'question');
  
  try {
    Logger.info(`Current transcript has ${APP_STATE.transcript.segments.length} segments`);
    const transcriptText = getTranscriptText();
    if (!transcriptText || transcriptText.trim().length === 0) {
      Logger.warn('No transcript data available');
      return displayQAMessage('No transcript available yet. Start capturing audio first.', 'answer');
    }
    Logger.info(`Sending transcript to API (${transcriptText.length} chars): ${transcriptText.substring(0, 100)}...`);
    const answer = await callOpenAIForQA(question, transcriptText);
    displayQAMessage(answer.text, 'answer', answer.citations);
  } catch (error) {
    Logger.error(`Q&A failed: ${error.message}`);
    displayQAMessage(`Error: ${error.message}`, 'answer');
    bootstrapAlert({ body: `Q&A failed: ${error.message}`, color: 'danger' });
  }
}

async function callOpenAIForQA(question, transcriptText) {
  const response = await fetch(`${APP_STATE.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getAuthToken()}` },
    body: JSON.stringify({
      model: APP_STATE.qaModel,
      messages: [
        { role: 'system', content: 'You are a helpful assistant analyzing a call center conversation transcript. Answer questions based ONLY on the provided transcript." Always cite specific quotes from the transcript to support your answers.' },
        { role: 'user', content: `Transcript:\n${transcriptText}\n\nQuestion: ${question}\n\nInstructions:\n1. Answer based ONLY on the transcript above\n2. Cite specific quotes to support your answer\n3. If information is not available, say "Not in the transcript yet"\n4. Format your response as JSON with this structure:\n{\n  "answer": "your answer here",\n  "citations": ["quote 1", "quote 2"]\n}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7
    })
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  const data = await response.json();
  const content = JSON.parse(data.choices[0].message.content);
  return { text: content.answer || 'No answer provided', citations: content.citations || [] };
}

function displayQAMessage(text, type, citations = []) {
  const container = $('qaContainer');
  const message = document.createElement('div');
  message.className = `qa-message qa-${type}`;
  message.innerHTML = `<strong>${type === 'question' ? '❓ Question' : '💡 Answer'}:</strong><br>${escapeHtml(text)}`;
  if (citations.length > 0) {
    const citationDiv = document.createElement('div');
    citationDiv.className = 'citation';
    citationDiv.innerHTML = '<strong>Citations:</strong><br>' + citations.map(c => `"${escapeHtml(c)}"`).join('<br>');
    message.appendChild(citationDiv);
  }
  container.appendChild(message);
  container.scrollTop = container.scrollHeight;
}

function toggleSummary(enabled) {
  APP_STATE.enableSummary = enabled;
  if (enabled) {
    Logger.info('2-minute summaries enabled');
    APP_STATE.summaryInterval = setInterval(generateSummary, 120000);
    if (APP_STATE.transcript.segments.length > 0) generateSummary();
  } else {
    Logger.info('2-minute summaries disabled');
    if (APP_STATE.summaryInterval) { clearInterval(APP_STATE.summaryInterval); APP_STATE.summaryInterval = null; }
  }
}

const toggleSuggestions = enabled => { APP_STATE.enableSuggestions = enabled; Logger.info(`Customer suggestions ${enabled ? 'enabled' : 'disabled'}`); };

async function generateSummary() {
  try {
    Logger.info('Generating 2-minute summary...');
    const transcriptText = getTranscriptText();
    if (!transcriptText) return $('summaryContent').textContent = 'No transcript available yet.';
    
    const response = await fetch(`${APP_STATE.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getAuthToken()}` },
      body: JSON.stringify({
        model: APP_STATE.qaModel,
        messages: [
          { role: 'system', content: 'You are a call center AI assistant. Provide concise, actionable insights.' },
          { role: 'user', content: `Analyze this call center conversation and provide:\n1. Brief summary (2-3 sentences)\n2. Current customer intent\n3. Key risks or concerns\n4. Recommended next steps\n\nTranscript:\n${transcriptText}\n\nRespond in JSON format:\n{\n  "summary": "...",\n  "intent": "...",\n  "risks": ["...", "..."],\n  "next_steps": ["...", "..."]\n}` }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7
      })
    });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const result = JSON.parse((await response.json()).choices[0].message.content);
    displaySummary(result);
    Logger.success('Summary generated');
  } catch (error) {
    Logger.error(`Summary generation failed: ${error.message}`);
    bootstrapAlert({ body: `Summary generation failed: ${error.message}`, color: 'danger' });
  }
}

function displaySummary(s) {
  $('summaryContent').innerHTML = `
    <p><strong>Summary:</strong> ${escapeHtml(s.summary || 'N/A')}</p>
    <p><strong>Customer Intent:</strong> ${escapeHtml(s.intent || 'N/A')}</p>
    <p><strong>Risks:</strong></p><ul class="mb-2">${(s.risks || []).map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
    <p><strong>Next Steps:</strong></p><ul class="mb-0">${(s.next_steps || []).map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
  `;
}

async function generateCustomerSuggestions() {
  if (APP_STATE.processingCustomerSuggestion) return;
  try {
    APP_STATE.processingCustomerSuggestion = true;
    Logger.info('Generating suggestions after customer speech...');
    const recentTranscript = APP_STATE.transcript.segments.slice(-10).map(s => `${s.channel === 'mic' ? 'AGENT' : 'CUSTOMER'}: ${s.text}`).join('\n');
    if (!recentTranscript) return;
    
    const response = await fetch(`${APP_STATE.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${await getAuthToken()}` },
      body: JSON.stringify({
        model: APP_STATE.qaModel,
        messages: [
          { role: 'system', content: 'You are a call center AI assistant. Provide helpful, professional suggestions.' },
          { role: 'user', content: `Based on this recent call center conversation, suggest:\n1. 3-5 best next questions the agent should ask\n2. 3-5 suggested responses the agent can say\n\nRecent conversation:\n${recentTranscript}\n\nRespond in JSON format:\n{\n  "questions": ["...", "...", "..."],\n  "replies": ["...", "...", "..."]\n}` }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.8
      })
    });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const result = JSON.parse((await response.json()).choices[0].message.content);
    displaySuggestions(result);
    Logger.success('Suggestions generated');
  } catch (error) {
    Logger.error(`Suggestion generation failed: ${error.message}`);
    bootstrapAlert({ body: `Suggestion generation failed: ${error.message}`, color: 'danger' });
  } finally {
    APP_STATE.processingCustomerSuggestion = false;
  }
}

function displaySuggestions(s) {
  $('nextQuestionsContent').innerHTML = s.questions?.length > 0 ? s.questions.map(q => `<div class="suggestion-item">${escapeHtml(q)}</div>`).join('') : '<p class="text-muted">No suggestions yet...</p>';
  $('suggestedRepliesContent').innerHTML = s.replies?.length > 0 ? s.replies.map(r => `<div class="suggestion-item">${escapeHtml(r)}</div>`).join('') : '<p class="text-muted">No suggestions yet...</p>';
}

async function startBoth() {
  try {
    await startMicCapture();
    await startSpeakerCapture();
    bootstrapAlert({ body: 'Both audio channels started successfully', color: 'success' });
  } catch (error) {
    Logger.error(`Failed to start both channels: ${error.message}`);
  }
}

function stopChannel(channel) {
  const channels = channel === 'all' ? ['mic', 'speaker'] : [channel];
  channels.forEach(ch => {
    ['Stream', 'Socket', 'Processor'].forEach(type => {
      const key = `${ch}${type}`;
      if (APP_STATE[key]) {
        if (type === 'Stream') APP_STATE[key].getTracks().forEach(t => t.stop());
        else if (type === 'Socket') APP_STATE[key].close();
        else APP_STATE[key].disconnect();
        APP_STATE[key] = null;
      }
    });
    updateStatus(ch, 'Disconnected', 'secondary');
    Logger.info(`${ch} stopped`);
  });
  if (channel === 'all' && APP_STATE.audioContext) { APP_STATE.audioContext.close(); APP_STATE.audioContext = null; }
}

const updateStatus = (channel, text, variant) => { const el = $(`${channel}Status`); el.textContent = text; el.className = `badge bg-${variant} ms-2`; };

document.addEventListener('DOMContentLoaded', () => {
  checkBrowserCompatibility();
  Logger.success('Call Center Copilot initialized');
  
  $('config-btn').addEventListener('click', () => initLLM(true));
  $('model-select').addEventListener('change', e => APP_STATE.model = e.target.value);
  $('qa-model').addEventListener('change', e => APP_STATE.qaModel = e.target.value);
  $('startMicBtn').addEventListener('click', () => startMicCapture().catch(err => Logger.error(`Start mic failed: ${err.message}`)));
  $('startSpeakerBtn').addEventListener('click', () => startSpeakerCapture().catch(err => Logger.error(`Start speaker failed: ${err.message}`)));
  $('startBothBtn').addEventListener('click', startBoth);
  $('stopAllBtn').addEventListener('click', () => { stopChannel('all'); bootstrapAlert({ body: 'All audio channels stopped', color: 'info' }); });
  $('clearMicBtn').addEventListener('click', () => clearTranscript('mic'));
  $('clearSpeakerBtn').addEventListener('click', () => clearTranscript('speaker'));
  $('askBtn').addEventListener('click', () => { askQuestion($('questionInput').value); $('questionInput').value = ''; });
  $('questionInput').addEventListener('keypress', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('askBtn').click(); } });
  $('enableSummaryToggle').addEventListener('change', e => toggleSummary(e.target.checked));
  $('enableSuggestionsToggle').addEventListener('change', e => toggleSuggestions(e.target.checked));
});

window.addEventListener('beforeunload', () => stopChannel('all'));
