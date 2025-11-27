// 全域變數
let socket = null;
let currentRoom = 'group';
let currentUser = null;
let typingTimer = null;
let onlineUsers = new Map();
let notifications = new Map();
let currentChatSocketId = null; // 當前私聊對象的 socket.id
let currentChatSessionId = null; // 當前私聊對象的 sessionId
let currentUserSessionId = null; // 自身的 sessionId
let currentChatPartnerName = null; // 私聊對象名稱
const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB 上傳限制
let latestOnlineSnapshot = { users: [], count: 0 };
let groupMembers = [];
let currentUserEmail = null;
const DEBUG_MEMBER_HEADER = false; // CHANGED: toggle member header debug logging

// Emoji 列表
const emojis = [
    '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
    '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰',
    '😘', '😗', '😙', '😚', '😋', '😛', '😜', '🤪',
    '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨',
    '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥',
    '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕',
    '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯',
    '🤠', '🥳', '😎', '🤓', '🧐', '😕', '😟', '🙁',
    '☹️', '😮', '😯', '😲', '😳', '🥺', '😦', '😧',
    '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣',
    '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠',
    '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹',
    '👺', '👻', '👽', '👾', '🤖', '❤️', '🧡', '💛',
    '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️',
    '💕', '💞', '💓', '💗', '💖', '💘', '💝', '👍',
    '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👏',
    '🙌', '👐', '🤲', '🙏', '✍️', '💪', '🦾', '🦿'
];

// DOM 元素
const elements = {
    onlineCount: document.getElementById('onlineCount'),
    usersList: document.getElementById('usersList'),
    chatTitle: document.getElementById('chatTitle'),
    chatSubtitle: document.getElementById('chatSubtitle'),
    chatHeaderActions: document.querySelector('.chat-header-actions'),
    chatAvatar: document.querySelector('.chat-avatar-placeholder'),
    settingsBtn: document.getElementById('settingsBtn'),
    chatWindow: document.querySelector('.chat-window'),
    chatBody: document.querySelector('.chat-body'),
    chatParticipants: document.getElementById('chatParticipants'),
    messagesArea: document.getElementById('messagesArea'),
    messageInput: document.getElementById('messageInput'),
    sendBtn: document.getElementById('sendBtn'),
    typingIndicator: document.getElementById('typingIndicator'),
    groupChatBtn: document.getElementById('groupChatBtn'),
    privateChatBtn: document.getElementById('privateChatBtn'),
    emojiBtn: document.getElementById('emojiBtn'),
    imageBtn: document.getElementById('imageBtn'),
    imageInput: document.getElementById('imageInput'),
    quitBtn: document.getElementById('quitBtn'),
    emojiPicker: document.getElementById('emojiPicker'),
    inputArea: document.querySelector('.input-area'),
    userName: document.getElementById('userName'),
    userAvatar: document.getElementById('userAvatar')
};

// 初始化
document.addEventListener('DOMContentLoaded', async function () {
    try {
        const resp = await fetch('/api/user');
        if (resp.ok) {
            const data = await resp.json();
            if (data.nickname) {
                currentUser = data.nickname;
                elements.userName.textContent = data.nickname;
            }
            if (data.userId) {
                currentUserSessionId = data.userId;
            }
            if (data.email) {
                currentUserEmail = data.email;
            }
        } else {
            console.error('獲取用戶資訊失敗：HTTP', resp.status);
        }
    } catch (error) {
        console.error('獲取用戶資訊失敗:', error);
    }

    // 確定已經拿到 currentUserSessionId / currentUser 再建立 socket
    initializeSocket();
    initializeEventListeners();
    initializeEmojiPicker();
});

// Socket.io 初始化
function initializeSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('已連接到伺服器');
    });
    
    socket.on('disconnect', () => {
        console.log('與伺服器斷開連接');
    });
    
    // 線上使用者更新
    socket.on('onlineUsers', (data) => {
        updateOnlineUsers(data);
    });
    
    // 接收新訊息
    socket.on('newMessage', (message) => {
        const isCurrentRoom = currentRoom === message.room;
        const isOwnMessage = message.senderSessionId
            ? message.senderSessionId === currentUserSessionId
            : message.nickname === currentUser;

        if (isCurrentRoom) {
            displayMessage(message);
        }
        
        if (!isCurrentRoom && !isOwnMessage) {
            if (message.room === 'group') {
                addNotification('group');
            } else if (message.room.startsWith('private_')) {
                const otherSessionId = getOtherSessionIdFromRoom(message.room);
                if (otherSessionId) {
                    addNotification(otherSessionId);
                }
            }
        }
    });
    
    // 使用者加入/離開
    socket.on('userJoined', (data) => {
        displaySystemMessage(`${data.nickname} 加入了聊天室`);
    });
    
    socket.on('userLeft', (data) => {
        displaySystemMessage(`${data.nickname} 離開了聊天室`);
    });
    
    // 輸入狀態
    socket.on('userTyping', (data) => {
        updateTypingIndicator(data);
    });
    
    socket.on('messageRejected', handleMessageRejected);

    socket.on('nicknameUpdated', (payload) => {
        const sessionId = payload?.sessionId;
        const nickname = payload?.nickname;
        if (!sessionId || !nickname) return;

        // 更新本地 onlineUsers 資料
        for (const [key, user] of onlineUsers.entries()) {
            if (user.sessionId === sessionId) {
                user.nickname = nickname;
                onlineUsers.set(key, user);
            }
        }

        // 更新列表 UI
        document.querySelectorAll('.user-item').forEach(item => {
            if (item.dataset.sessionId === sessionId) {
                const title = item.querySelector('.user-title');
                if (title) {
                    title.textContent = nickname;
                }
                const avatar = item.querySelector('.user-avatar-initial');
                if (avatar && nickname) {
                    avatar.textContent = nickname.charAt(0).toUpperCase();
                }
            }
        });

        // 若是自己，同步 header 與變數
        if (sessionId === currentUserSessionId) {
            currentUser = nickname;
            elements.userName.textContent = nickname;
        }

        refreshHeaderMeta(currentRoom);
    });
    
    // 聊天歷史
    socket.on('chatHistory', (data) => {
        if (data.room !== currentRoom) {
            return;
        }

        if (data.room === 'group' && Array.isArray(data.members)) {
            setGroupMembers(data.members);
        }

        elements.messagesArea.innerHTML = '';
        data.messages.forEach(message => {
            displayMessage(message);
        });

        refreshHeaderMeta(currentRoom);
    });
}

// 初始化事件監聽器
function initializeEventListeners() {
    // 發送訊息
    elements.sendBtn.addEventListener('click', sendMessage);
    elements.messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
        } else {
            handleTyping();
        }
    });
    
    // 房間 / 會話類型切換（Tabs）
    elements.groupChatBtn.addEventListener('click', () => {
        // 「Groups」代表群組聊天室
        switchRoom('group');
        elements.groupChatBtn.classList.add('active');
        elements.privateChatBtn.classList.remove('active');
    });

    elements.privateChatBtn.addEventListener('click', () => {
        // 「Personal」只作為視覺提示：真正的私聊房間在點擊使用者時建立
        if (currentRoom === 'group') {
            alert('請點擊使用者列表中的使用者開始私聊');
        }
        elements.groupChatBtn.classList.remove('active');
        elements.privateChatBtn.classList.add('active');
    });
    
    // 功能按鈕
    elements.emojiBtn.addEventListener('click', toggleEmojiPicker);
    elements.imageBtn.addEventListener('click', () => elements.imageInput.click());
    elements.imageInput.addEventListener('change', handleImageUpload);
    if (elements.settingsBtn) {
        elements.settingsBtn.addEventListener('click', promptNicknameChange);
    }
    
    // 登出按鈕
    elements.quitBtn.addEventListener('click', () => {
        if (confirm('確定要離開聊天室嗎？')) {
            window.location.href = '/logout';
        }
    });
    
    // 點擊其他地方關閉 emoji 選擇器
    document.addEventListener('click', (e) => {
        if (!elements.emojiBtn.contains(e.target) && !elements.emojiPicker.contains(e.target)) {
            elements.emojiPicker.classList.remove('active');
        }
    });
}

// 初始化 Emoji 選擇器
function initializeEmojiPicker() {
    const emojiGrid = elements.emojiPicker.querySelector('.emoji-grid');
    
    emojis.forEach(emoji => {
        const emojiItem = document.createElement('div');
        emojiItem.className = 'emoji-item';
        emojiItem.textContent = emoji;
        emojiItem.addEventListener('click', () => {
            elements.messageInput.value += emoji;
            elements.messageInput.focus();
            elements.emojiPicker.classList.remove('active');
        });
        emojiGrid.appendChild(emojiItem);
    });
}

// 更新線上使用者列表
function updateOnlineUsers(data) {
    latestOnlineSnapshot = {
        users: Array.isArray(data.users) ? [...data.users] : [],
        count: Number.isFinite(data.count) ? data.count : 0
    };

    elements.onlineCount.textContent = data.count;
    elements.usersList.innerHTML = '';
    onlineUsers.clear();

    data.users.forEach(user => {
        onlineUsers.set(user.id, user);

        // 過濾掉自己（以 sessionId 為準）
        if (currentUserSessionId && user.sessionId === currentUserSessionId) {
            currentUser = currentUser || user.nickname;
            return;
        }

        const userItem = document.createElement('div');
        userItem.className = 'user-item';
        userItem.dataset.socketId = user.id;
        userItem.dataset.sessionId = user.sessionId;

        // 聯絡人頭像（以暱稱首字母為 avatar）
        const avatar = document.createElement('div');
        avatar.className = 'user-avatar-initial';
        avatar.textContent = (user.nickname || '?').charAt(0).toUpperCase();

        // 文字資訊區塊
        const meta = document.createElement('div');
        meta.className = 'user-meta';

        const title = document.createElement('div');
        title.className = 'user-title';
        title.textContent = user.nickname || '使用者';

        const previewRow = document.createElement('div');
        previewRow.className = 'user-preview-row';

        const lastMessage = document.createElement('div');
        lastMessage.className = 'user-last-message';
        lastMessage.textContent = '點擊開始私聊';

        const timestamp = document.createElement('div');
        timestamp.className = 'user-timestamp';
        timestamp.textContent = '';

        previewRow.appendChild(lastMessage);
        previewRow.appendChild(timestamp);
        meta.appendChild(title);
        meta.appendChild(previewRow);

        // 未讀徽章
        const badge = document.createElement('span');
        badge.className = 'notification-badge';

        userItem.appendChild(avatar);
        userItem.appendChild(meta);
        userItem.appendChild(badge);

        if (currentChatSessionId && user.sessionId === currentChatSessionId) {
            userItem.classList.add('active');
        }

        userItem.addEventListener('click', () => {
            startPrivateChat(user);
        });

        elements.usersList.appendChild(userItem);
    });

    updateNotificationBadges();
    refreshHeaderMeta(currentRoom);
}

// 切換房間
function switchRoom(room) {
    const notificationKey = getNotificationKeyForRoom(room);
    if (notificationKey) {
        clearNotification(notificationKey);
    }
    
    elements.typingIndicator.textContent = '';
    elements.typingIndicator.style.display = 'none';
    
    currentRoom = room;
    
    if (room === 'group') {
        elements.chatTitle.textContent = 'Group';
        currentChatSocketId = null;
        currentChatSessionId = null;
        currentChatPartnerName = null;
        document.querySelectorAll('.user-item').forEach(item => {
            item.classList.remove('active');
        });
    }
    
    socket.emit('switchRoom', { room });
    socket.emit('getChatHistory', { room });
    refreshHeaderMeta(room);
}

// 開始私聊
function startPrivateChat(user) {
    if (!user || !user.sessionId) {
        return;
    }
    if (!currentUserSessionId) {
        console.warn('尚未取得使用者 sessionId，無法建立私聊房間。');
        return;
    }

    currentChatSocketId = user.id;
    currentChatSessionId = user.sessionId;
    currentChatPartnerName = user.nickname;
    
    const privateRoomName = generatePrivateRoomName(currentUserSessionId, user.sessionId);
    
    elements.chatTitle.textContent = user.nickname;
    clearNotification(user.sessionId);
    
    switchRoom(privateRoomName);
    
    document.querySelectorAll('.user-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.sessionId === user.sessionId) {
            item.classList.add('active');
        }
    });

    refreshHeaderMeta(privateRoomName);
}

// 發送訊息
function sendMessage() {
    const content = elements.messageInput.value.trim();
    if (!content) return;
    const targetRoom = currentRoom === 'group' ? 'group' : currentChatSocketId;
    if (!targetRoom) {
        alert('請先選擇聊天對象');
        return;
    }
    
    const message = {
        content,
        type: 'text',
        room: targetRoom
    };
    
    socket.emit('sendMessage', message);
    elements.messageInput.value = '';
    
    // 停止輸入狀態
    clearTimeout(typingTimer);
    socket.emit('typing', { room: targetRoom, isTyping: false });
}

// 顯示訊息
function displayMessage(message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    
    const isOwnMessage = message.senderSessionId
        ? message.senderSessionId === currentUserSessionId
        : message.nickname === currentUser;

    if (isOwnMessage) {
        messageDiv.classList.add('own');
    }
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    // 訊息頭部（暱稱）
    if (!isOwnMessage) {
        const headerDiv = document.createElement('div');
        headerDiv.className = 'message-header';
        headerDiv.textContent = message.nickname;
        contentDiv.appendChild(headerDiv);
    }
    
    // 訊息內容
    if (message.type === 'text' || message.type === 'emoji') {
        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        textDiv.textContent = message.content;
        contentDiv.appendChild(textDiv);
    } else if (message.type === 'image') {
        contentDiv.classList.add('image-message');
        const img = document.createElement('img');
        img.className = 'message-image';
        img.src = message.content;
        contentDiv.appendChild(img);
    }
    
    // 時間戳
    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    timeDiv.textContent = formatChatTime(message.timestamp);
    contentDiv.appendChild(timeDiv);
    
    messageDiv.appendChild(contentDiv);
    elements.messagesArea.appendChild(messageDiv);
    
    // 滾動到底部
    elements.messagesArea.scrollTop = elements.messagesArea.scrollHeight;
}

// 顯示系統訊息
function displaySystemMessage(text) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'system-message';
    messageDiv.textContent = text;
    elements.messagesArea.appendChild(messageDiv);
    
    // 滾動到底部
    elements.messagesArea.scrollTop = elements.messagesArea.scrollHeight;
}

// 處理輸入狀態
function handleTyping() {
    clearTimeout(typingTimer);
    
    const roomParam = currentRoom === 'group' ? 'group' : currentChatSocketId;
    if (!roomParam) {
        return;
    }
    socket.emit('typing', { room: roomParam, isTyping: true });
    
    typingTimer = setTimeout(() => {
        socket.emit('typing', { room: roomParam, isTyping: false });
    }, 1000);
}

// 更新輸入狀態顯示
function updateTypingIndicator(data) {
    // 只在對應的聊天室顯示輸入狀態
    let shouldShow = false;
    
    if (currentRoom === 'group') {
        // 群聊時顯示所有人的輸入狀態
        shouldShow = true;
    } else if (currentChatSessionId) {
        // 私聊時只顯示對方的輸入狀態
        const user = onlineUsers.get(data.userId);
        if (user && user.sessionId === currentChatSessionId) {
            shouldShow = true;
        }
    }
    
    if (shouldShow) {
        if (data.isTyping) {
            elements.typingIndicator.textContent = `${data.nickname} 正在輸入...`;
            elements.typingIndicator.style.display = 'block';
        } else {
            elements.typingIndicator.textContent = '';
            elements.typingIndicator.style.display = 'none';
        }
    }
}

// 切換 Emoji 選擇器
function toggleEmojiPicker() {
    elements.emojiPicker.classList.toggle('active');
}

// 處理圖片上傳
async function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith('image/')) return;

    const targetRoom = currentRoom === 'group' ? 'group' : currentChatSocketId;
    if (!targetRoom) {
        alert('請先選擇聊天對象');
        elements.imageInput.value = '';
        return;
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
        alert('圖片大小不得超過 2MB，請重新選擇。');
        elements.imageInput.value = '';
        return;
    }

    try {
        const res = await fetch(`/api/s3-upload-url?fileType=${encodeURIComponent(file.type)}&fileName=${encodeURIComponent(file.name)}`);
        if (!res.ok) throw new Error('無法取得上傳權限');

        const { uploadUrl, publicUrl } = await res.json();
        const uploadRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': file.type
            },
            body: file
        });

        if (!uploadRes.ok) throw new Error('上傳 S3 失敗');

        socket.emit('sendMessage', {
            content: publicUrl,
            type: 'image',
            room: targetRoom
        });

        console.log('圖片發送成功:', publicUrl);
    } catch (err) {
        console.error(err);
        alert('圖片上傳失敗');
    }

    elements.imageInput.value = '';
}

function handleMessageRejected(data) {
    const messages = {
        IMAGE_TOO_LARGE: '圖片大小超過 500KB，請嘗試壓縮後再上傳。',
        TARGET_OFFLINE: '對方已離線，無法傳送訊息。'
    };
    const feedback = messages[data?.reason] || '訊息發送失敗，請稍後再試。';
    displaySystemMessage(feedback);
}

// 通知管理
function addNotification(room) {
    if (!room) {
        return;
    }
    const count = (notifications.get(room) || 0) + 1;
    notifications.set(room, count);
    updateNotificationBadges();
}

function clearNotification(room) {
    if (!room) {
        return;
    }
    notifications.delete(room);
    updateNotificationBadges();
}

function updateNotificationBadges() {
    // 更新私聊通知（紅點）
    document.querySelectorAll('.user-item').forEach(item => {
        const sessionId = item.dataset.sessionId;
        const badge = item.querySelector('.notification-badge');
        const count = notifications.get(sessionId) || 0;
        
        if (count > 0) {
            badge.classList.add('private');
            badge.textContent = count > 9 ? '9+' : count;
            badge.style.display = 'inline-block';
        } else {
            badge.classList.remove('private');
            badge.textContent = '';
            badge.style.display = 'none';
        }
    });
    
    // 更新群組通知（黃點）
    const groupNotification = document.getElementById('groupNotification');
    const groupCount = notifications.get('group') || 0;
    
    if (groupCount > 0 && currentRoom !== 'group') {
        groupNotification.classList.add('show');
    } else {
        groupNotification.classList.remove('show');
    }
}

function setGroupMembers(members) {
    if (!Array.isArray(members)) {
        return;
    }

    const seen = new Set();
    const normalized = [];

    members.forEach((member) => {
        const email = (member?.email || '').trim();
        const nickname = (member?.nickname || '').trim();
        const userId = member?.userId || member?.id || null;
        const key = (email || nickname || '').toLowerCase();
        if (!key || seen.has(key)) {
            return;
        }
        seen.add(key);
        if (userId && userId === currentUserSessionId && email) {
            currentUserEmail = email;
        }
        normalized.push({
            email: email || null,
            nickname: nickname || null,
            userId
        });
    });

    groupMembers = normalized;
}

function getSessionIdsFromRoom(room) {
    if (!room || !room.startsWith('private_')) {
        return [];
    }
    return room.replace('private_', '').split('_');
}

function getOtherSessionIdFromRoom(room) {
    const sessionIds = getSessionIdsFromRoom(room);
    if (sessionIds.length === 0) {
        return null;
    }
    if (!currentUserSessionId) {
        return sessionIds[0];
    }
    return sessionIds.find(id => id !== currentUserSessionId) || sessionIds[0];
}

function getNotificationKeyForRoom(room) {
    if (room === 'group') {
        return 'group';
    }
    return getOtherSessionIdFromRoom(room);
}

function refreshHeaderMeta(room) {
    if (!elements.chatSubtitle || !elements.chatParticipants) {
        return;
    }

    if (room === 'group') {
        const count = latestOnlineSnapshot.count || 0;
        elements.chatSubtitle.textContent = `群組聊天室 · ${count} 人在線`;
        setHeaderAvatar('👥');

        const headerMembers = groupMembers.length > 0
            ? groupMembers
            : latestOnlineSnapshot.users.map((user) => ({
                email: user.email || null,
                nickname: user.nickname,
                userId: user.sessionId || user.id || null
            }));

        logMemberHeaderDebug({
            room,
            type: 'group',
            members: headerMembers,
            currentUserSessionId,
            currentUserEmail,
            currentUser
        });
        elements.chatParticipants.classList.remove('hidden');
        elements.chatParticipants.textContent = buildMemberHeaderText(headerMembers);
        return;
    }

    const counterpart =
        latestOnlineSnapshot.users.find(user => user.sessionId === currentChatSessionId) ||
        Array.from(onlineUsers.values()).find(user => user.sessionId === currentChatSessionId);

    const counterpartName = counterpart?.nickname || currentChatPartnerName || '離線使用者';
    const avatarInitial = counterpartName ? counterpartName.charAt(0).toUpperCase() : '👤';
    setHeaderAvatar(avatarInitial);

    elements.chatSubtitle.textContent = counterpartName
        ? `私人對話 · ${counterpartName}`
        : '私人對話';
    elements.chatParticipants.classList.add('hidden');
    elements.chatParticipants.textContent = '';
}

function setHeaderAvatar(text) {
    if (!elements.chatAvatar) return;
    elements.chatAvatar.textContent = text || '';
}

function logMemberHeaderDebug(context) { // NEW: optional debug logger
    if (!DEBUG_MEMBER_HEADER) return;
    try {
        // eslint-disable-next-line no-console
        console.log('[member-header]', JSON.stringify(context, null, 2));
    } catch (error) {
        // ignore logging errors
    }
}

// CHANGED: 成員標題生成邏輯（以身分 key 去重，自己顯示「你」）
function formatMemberLabels(members) {
    if (!Array.isArray(members)) return [];

    const seenKeys = new Set();
    const labels = [];

    members.forEach((m) => {
        if (!m) return;

        const rawEmail = (m.email || m.userEmail || '').trim();
        const rawName =
            (m.displayName ||
                m.username ||
                m.name ||
                m.nickname ||
                rawEmail ||
                '').trim();
        const idKeyRaw = m.userId || m.id || m.sessionId || null;
        const idKey = idKeyRaw ? String(idKeyRaw).trim() : '';
        const identityKey = (idKey || rawEmail || rawName || '').toLowerCase();
        if (!identityKey) return;

        // 先用「身分 key」去重（同一個人只保留一次）
        if (seenKeys.has(identityKey)) return;
        seenKeys.add(identityKey);

        const currentIdKey = currentUserSessionId ? String(currentUserSessionId).trim() : '';
        const isSelfById = currentIdKey && idKey && currentIdKey === idKey;
        const isSelfByEmail =
            !!currentUserEmail &&
            !!rawEmail &&
            rawEmail.toLowerCase() === currentUserEmail.toLowerCase();
        const isSelfByName =
            !rawEmail &&
            !!currentUser &&
            !!rawName &&
            rawName.toLowerCase() === currentUser.toLowerCase();

        const isSelf = isSelfById || isSelfByEmail || isSelfByName;
        const label = isSelf ? '你' : (rawName || rawEmail);

        if (label) {
            labels.push(label);
        }
    });

    return labels;
}

// CHANGED: 成員標題組字串
function buildMemberHeaderText(members) {
    const labels = formatMemberLabels(members);
    if (labels.length === 0) {
        return '成員：--';
    }

    if (labels.length === 1) {
        return `成員：${labels[0]}`;
    }

    return `成員：${labels.join('、')}`;
}

function formatChatTime(timestamp) {
    const date = new Date(timestamp);
    const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    const weekday = weekdays[date.getDay()];

    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? '下午' : '上午';
    hours = hours % 12;
    if (hours === 0) hours = 12;

    return `${weekday} ${ampm}${hours}:${minutes}`;
}

// 生成私聊房間名稱（使用 sessionId 與後端保持一致）
function generatePrivateRoomName(sessionId1, sessionId2) {
    const sortedIds = [sessionId1, sessionId2].sort();
    return `private_${sortedIds[0]}_${sortedIds[1]}`;
} 

// 修改暱稱
async function promptNicknameChange() {
    const newName = prompt('請輸入新的暱稱', currentUser || '');
    if (newName === null) return;
    const trimmed = newName.trim();
    if (!trimmed) {
        alert('暱稱不可為空');
        return;
    }
    if (trimmed.length > 50) {
        alert('暱稱長度需在 1-50 字內');
        return;
    }

    try {
        const resp = await fetch('/api/user/nickname', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nickname: trimmed })
        });
        const data = await resp.json();
        if (!resp.ok || !data?.success) {
            const msg = data?.message || data?.error || '更新暱稱失敗，請稍後再試';
            alert(msg);
            return;
        }

        currentUser = trimmed;
        elements.userName.textContent = trimmed;
        refreshHeaderMeta(currentRoom);
    } catch (error) {
        console.error('更新暱稱失敗', error);
        alert('更新暱稱失敗，請稍後再試');
    }
}
