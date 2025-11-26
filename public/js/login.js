document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('loginForm');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const togglePasswordBtn = document.getElementById('togglePassword');
    const errorMessage = document.getElementById('errorMessage');
    const infoMessage = document.getElementById('infoMessage');
    const primarySubmitBtn = document.getElementById('primarySubmitBtn');
    const switchModeBtn = document.getElementById('switchModeBtn');
    const switchModeText = document.getElementById('switchModeText');
    const cardTitle = document.getElementById('cardTitle');
    const googleSignInBtn = document.getElementById('googleSignInBtn');
    const forgotPasswordLink = document.getElementById('forgotPasswordLink');
    const resendVerificationBtn = document.getElementById('resendVerificationBtn');

    // mode: 'signin' | 'signup'
    let mode = 'signin';

    emailInput.focus();

    // Controls the current auth mode (signin/signup) and syncs related UI state.
    function setMode(nextMode) {
        mode = nextMode;
        clearMessages();

        if (mode === 'signin') {
            cardTitle.textContent = 'Sign in with email';
            primarySubmitBtn.textContent = 'Sign in';
            switchModeText.textContent = 'Don’t have an account?';
            switchModeBtn.textContent = 'Sign up';
        } else {
            cardTitle.textContent = 'Create your account';
            primarySubmitBtn.textContent = 'Get Started';
            switchModeText.textContent = 'Already have an account?';
            switchModeBtn.textContent = 'Sign in';
        }

        if (resendVerificationBtn) {
            resendVerificationBtn.style.display = mode === 'signup' ? 'inline-flex' : 'none';
        }
    }

    function showError(message) {
        if (!errorMessage) return;
        errorMessage.textContent = message || '';
        errorMessage.classList.add('show');
    }

    function showInfo(message) {
        if (!infoMessage) return;
        infoMessage.textContent = message || '';
        infoMessage.classList.add('show');
    }

    function clearMessages() {
        if (errorMessage) {
            errorMessage.textContent = '';
            errorMessage.classList.remove('show');
        }
        if (infoMessage) {
            infoMessage.textContent = '';
            infoMessage.classList.remove('show');
        }
    }

    setMode(mode);

    togglePasswordBtn.addEventListener('click', () => {
        const isHidden = passwordInput.type === 'password';
        passwordInput.type = isHidden ? 'text' : 'password';
        togglePasswordBtn.textContent = isHidden ? 'Hide' : 'Show';
    });

    switchModeBtn.addEventListener('click', () => {
        setMode(mode === 'signin' ? 'signup' : 'signin');
    });

    forgotPasswordLink.addEventListener('click', async () => {
        clearMessages();
        const email = (emailInput.value || '').trim();
        if (!email) {
            showError('請先輸入 Email 再使用忘記密碼');
            return;
        }
        try {
            const response = await fetch('/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            if (response.status === 501) {
                showInfo('重設密碼功能尚未實作，請先使用 Email 驗證後登入。');
            } else {
                showInfo('若帳號存在，將會寄送重設密碼指引。');
            }
        } catch (error) {
            console.error('Forgot password error:', error);
            showError('伺服器錯誤，請稍後再試');
        }
    });

    googleSignInBtn.addEventListener('click', () => {
        window.location.href = '/auth/google';
    });

    async function resendVerificationEmail(email) {
        const response = await fetch('/auth/resend-verification', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const { data, isJson } = await parseJsonSafe(response);

        if (response.ok && data && data.success) {
            showInfo(
                data.message ||
                    '如果此 Email 有註冊，我們已重新寄出驗證信，請稍候並檢查信箱。'
            );
            return;
        }

        let fallback = '伺服器發生錯誤，請稍後再試';
        if (response.status === 400) {
            fallback = '請提供有效的 Email';
        } else if (response.status === 429) {
            fallback = '請稍後再重新請求驗證信';
        }

        if (isJson) {
            showError(resolveErrorMessage(data, fallback));
        } else {
            showError(fallback);
        }
    }

    if (resendVerificationBtn) {
        resendVerificationBtn.addEventListener('click', async () => {
            clearMessages();

            const email = (emailInput.value || '').trim();
            if (!email) {
                showError('請先輸入 Email 再重寄驗證信');
                return;
            }

            try {
                resendVerificationBtn.disabled = true;
                await resendVerificationEmail(email);
            } catch (error) {
                console.error('Resend verification failed:', error);
                showError('伺服器錯誤，請稍後再試');
            } finally {
                resendVerificationBtn.disabled = false;
            }
        });
    }

    const ERROR_MESSAGES = {
        EMAIL_ALREADY_EXISTS: '這個 Email 已被註冊，請改用其他 Email',
        EMAIL_ALREADY_REGISTERED: '這個 Email 已被註冊，請改用其他 Email',
        INVALID_INPUT: '輸入格式不正確，請檢查 Email 與密碼',
        INVALID_EMAIL: '請提供有效的 Email',
        INVALID_CREDENTIALS: 'Email 或密碼錯誤',
        EMAIL_NOT_VERIFIED: 'Email 尚未驗證，請先到信箱點擊驗證連結',
        SERVER_ERROR: '伺服器發生錯誤，請稍後再試',
        INTERNAL_ERROR: '伺服器發生錯誤，請稍後再試',
        TOO_MANY_REQUESTS: '請稍後再重新請求驗證信'
    };

    function isJsonResponse(response) {
        const contentType = response.headers.get('content-type') || '';
        return contentType.toLowerCase().includes('application/json');
    }

    async function parseJsonSafe(response) {
        const isJson = isJsonResponse(response);
        if (!isJson) {
            return { data: null, isJson: false };
        }
        try {
            const data = await response.json();
            return { data, isJson: true };
        } catch (error) {
            console.warn('Failed to parse JSON response', error);
            return { data: null, isJson: true };
        }
    }

    function resolveErrorMessage(data, fallbackMessage) {
        if (!data) return fallbackMessage;
        const code = data.error || data.errorCode;
        if (code && ERROR_MESSAGES[code]) {
            return ERROR_MESSAGES[code];
        }
        if (typeof data.message === 'string' && data.message.trim()) {
            return data.message.trim();
        }
        return fallbackMessage;
    }

    function setSubmitting(isSubmitting) {
        if (!primarySubmitBtn) return;
        primarySubmitBtn.disabled = isSubmitting;
        if (isSubmitting) {
            primarySubmitBtn.dataset.label = primarySubmitBtn.textContent || '';
            primarySubmitBtn.textContent = mode === 'signup' ? 'Creating...' : 'Signing in...';
        } else if (primarySubmitBtn.dataset.label) {
            primarySubmitBtn.textContent = primarySubmitBtn.dataset.label;
            delete primarySubmitBtn.dataset.label;
        }
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearMessages();

        const email = (emailInput.value || '').trim();
        const password = passwordInput.value || '';

        if (!email || !password) {
            showError('請輸入 Email 與密碼');
            return;
        }

        if (mode === 'signup' && password.length < 6) {
            showError('密碼至少需要 6 個字元');
            return;
        }

        try {
            setSubmitting(true);

            if (mode === 'signup') {
                const response = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const { data, isJson } = await parseJsonSafe(response);

                if (response.ok && data && data.success) {
                    showInfo(data.message || '註冊成功，請至信箱完成驗證。');
                    return;
                }

                if (!response.ok) {
                    if (!isJson) {
                        showError('伺服器發生錯誤，請稍後再試');
                        return;
                    }

                    let fallback = '註冊失敗，請稍後再試';
                    if (response.status === 409) {
                        fallback = '這個 Email 已被註冊，請改用其他 Email';
                    } else if (response.status === 400 || response.status === 422) {
                        fallback = '輸入格式不正確，請檢查 Email 與密碼';
                    } else if (response.status >= 500) {
                        fallback = '伺服器發生錯誤，請稍後再試';
                    }
                    showError(resolveErrorMessage(data, fallback));
                    return;
                }

                showError('註冊失敗，請稍後再試');
                return;
            }

            // Sign-in mode
            const response = await fetch('/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const { data, isJson } = await parseJsonSafe(response);

            if (response.ok && data && data.success) {
                window.location.href = '/chat';
                return;
            }

            if (isJson && data && data.errorCode === 'EMAIL_NOT_VERIFIED') {
                showError('Email 尚未驗證，請先到信箱點擊驗證連結。');
                try {
                    await resendVerificationEmail(email);
                } catch (resendError) {
                    console.error('Resend verification error:', resendError);
                }
                return;
            }

            if (!response.ok) {
                if (!isJson) {
                    showError('伺服器發生錯誤，請稍後再試');
                    return;
                }

                let fallback = '登入失敗，請稍後再試';
                if (response.status === 400 || response.status === 422) {
                    fallback = '輸入格式不正確，請檢查 Email 與密碼';
                } else if (response.status === 401) {
                    fallback = 'Email 或密碼錯誤';
                } else if (response.status >= 500) {
                    fallback = '伺服器發生錯誤，請稍後再試';
                }
                showError(resolveErrorMessage(data, fallback));
            } else {
                showError(resolveErrorMessage(data, '登入失敗，請稍後再試'));
            }
        } catch (error) {
            console.error('Auth error:', error);
            showError('無法連接到伺服器，請檢查網路連線');
        } finally {
            setSubmitting(false);
        }
    });

    emailInput.addEventListener('input', clearMessages);
    passwordInput.addEventListener('input', clearMessages);
});
