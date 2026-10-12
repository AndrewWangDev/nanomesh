/* public/auth.js */
import { t, setLocale, getLocale } from './i18n.js?v=1791442000000';

export function checkTermsAgreed() {
  const termsCheckbox = document.getElementById('terms-checkbox');
  if (termsCheckbox && !termsCheckbox.checked) {
    showToast(t('auth.termsRequired'), 'error');
    const row = termsCheckbox.closest('.terms-agreement-row');
    if (row) {
      row.classList.remove('shake-highlight');
      void row.offsetWidth; // trigger reflow
      row.classList.add('shake-highlight');
    }
    return false;
  }
  return true;
}



let siteKey = '';

export function showToast(message, type = 'error') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

let tsWidgetId = null;
let tsState = 'verifying';
let pendingSubmit = null;

function updateButtonVisuals() {
  const submitBtn = document.querySelector('.auth-container button[type="submit"]');
  const sendCodeBtn = document.getElementById('btn-send-code');
  const emailPrefix = document.getElementById('email-prefix');
  const termsCheckbox = document.getElementById('terms-checkbox');
  const isTermsChecked = termsCheckbox ? termsCheckbox.checked : true;
  const isReady = (tsState === 'success' && isTermsChecked);

  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.style.transition = 'all 0.2s ease-in-out';
    if (isReady) {
      submitBtn.style.opacity = '1';
    } else {
      submitBtn.style.opacity = '0.5';
    }
    if (!pendingSubmit && submitBtn.dataset.originalText) {
      submitBtn.textContent = submitBtn.dataset.originalText;
      delete submitBtn.dataset.originalText;
    }
  }

  if (sendCodeBtn) {
    if (sendCodeBtn.dataset.countdown === "true") {
      sendCodeBtn.disabled = true;
      sendCodeBtn.style.opacity = '0.5';
    } else {
      const isEmailEmpty = emailPrefix ? !emailPrefix.value.trim() : false;
      if (isEmailEmpty) {
        sendCodeBtn.disabled = true;
        sendCodeBtn.style.opacity = '0.5';
      } else {
        sendCodeBtn.disabled = false;
        sendCodeBtn.style.transition = 'all 0.2s ease-in-out';
        if (isReady) {
          sendCodeBtn.style.opacity = '1';
        } else {
          sendCodeBtn.style.opacity = '0.5';
        }
      }
      if (!pendingSubmit && sendCodeBtn.dataset.originalText) {
        sendCodeBtn.textContent = sendCodeBtn.dataset.originalText;
        delete sendCodeBtn.dataset.originalText;
      }
    }
  }
}

function resetTurnstile() {
  tsState = 'verifying';
  pendingSubmit = null;
  if (tsWidgetId !== null && window.turnstile) {
    window.turnstile.reset(tsWidgetId);
  }
  updateButtonVisuals();
}

function shakeTurnstile() {
  const tsContainer = document.getElementById('turnstile-container');
  const wrapper = tsContainer ? tsContainer.closest('.turnstile-wrapper') || tsContainer : null;
  if (wrapper) {
    wrapper.classList.remove('shake-highlight');
    void wrapper.offsetWidth; // trigger reflow
    wrapper.classList.add('shake-highlight');
  }
}

function handleAuthSubmitClick(e, submitFn) {
  e.preventDefault();
  if (tsState === 'success') {
    submitFn();
  } else {
    const btn = e.submitter || e.target.closest('button') || e.target;
    if (btn && btn.tagName === 'BUTTON' && !btn.dataset.originalText) {
      btn.dataset.originalText = btn.textContent;
      btn.textContent = t('auth.waitingCaptcha');
    }
    pendingSubmit = submitFn;
    
    if (tsState !== 'success') {
      shakeTurnstile();
    }
  }
}

function handleAuthError(resData, defaultKey) {
  resetTurnstile();
  if (!resData || !resData.error) {
    showToast(t(defaultKey));
    return;
  }
  const err = resData.error;
  if (err === 'Invalid captcha') {
    showToast(t('error.invalidCaptcha'));
  } else if (err === 'Invalid email or password' || err === 'User not found' || err === 'Invalid credentials') {
    showToast(t('error.loginFailed'));
  } else if (err === 'Please login with OAuth') {
    showToast(t('error.loginWithOAuth'));
  } else {
    showToast(t(err) !== err ? t(err) : err);
  }
}


let turnstileLoaded = false;
let configLoaded = false;

window.onloadTurnstileCallback = () => {
  turnstileLoaded = true;
  tryRenderTurnstile();
};

// Fallback in case onload is missed
if (window.turnstile) {
  turnstileLoaded = true;
} else {
  const checkTs = setInterval(() => {
    if (window.turnstile) {
      turnstileLoaded = true;
      clearInterval(checkTs);
      tryRenderTurnstile();
    }
  }, 100);
}

function tryRenderTurnstile() {
  if (turnstileLoaded && configLoaded && tsWidgetId === null) {
    const tsContainer = document.getElementById('turnstile-container');
  const wrapper = tsContainer ? tsContainer.closest('.turnstile-wrapper') || tsContainer : null;
    if (tsContainer && siteKey) {
      tsContainer.innerHTML = '';
      tsState = 'verifying';
      updateButtonVisuals();
      
      tsWidgetId = window.turnstile.render(tsContainer, {
        sitekey: siteKey,
        theme: document.documentElement.getAttribute('data-theme') || 'dark',
        callback: () => {
          tsState = 'success';
          if (pendingSubmit) {
            const submitFn = pendingSubmit;
            pendingSubmit = null;
            updateButtonVisuals();
            submitFn();
          } else {
            updateButtonVisuals();
          }
        },
        beforeInteractiveCallback: () => {
          tsState = 'interactive';
          if (pendingSubmit) {
            shakeTurnstile();
          }
        },
        expiredCallback: () => {
          tsState = 'expired';
          pendingSubmit = null;
          updateButtonVisuals();
        },
        errorCallback: () => {
          tsState = 'error';
          pendingSubmit = null;
          updateButtonVisuals();
        }
      });
    }
  }
}

async function initTurnstile() {
  try {
    const res = await fetch('/api/auth/config');
    if (res.ok) {
      const data = await res.json();
      siteKey = data.turnstile_site_key;
      configLoaded = true;
      tryRenderTurnstile();
    }
  } catch (err) {
    console.error('Failed to load auth config', err);
  }
}

function initThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;
  const savedTheme = localStorage.getItem('nanomesh-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  
  toggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('nanomesh-theme', newTheme);
  });
}

function initLangToggle() {
  const toggle = document.getElementById('lang-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const newLang = getLocale() === 'zh' ? 'en' : 'zh';
    setLocale(newLang);
  });
}


// --- Form Draft Auto-Save & Restore (Guarantees form inputs persist when viewing terms/privacy) ---
function initFormPersistence() {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  if (loginForm) {
    const emailInput = document.getElementById('email');
    const pwdInput = document.getElementById('password');
    const termsCheckbox = document.getElementById('terms-checkbox');

    // Restore draft
    try {
      const saved = sessionStorage.getItem('nanomesh_login_draft');
      if (saved) {
        const data = JSON.parse(saved);
        if (data.email && emailInput) emailInput.value = data.email;
        if (data.password && pwdInput) pwdInput.value = data.password;
        if (typeof data.termsChecked === 'boolean' && termsCheckbox) {
          termsCheckbox.checked = data.termsChecked;
        }
        updateButtonVisuals();
      }
    } catch (e) {}

    // Auto-save on input
    const saveLoginDraft = () => {
      try {
        sessionStorage.setItem('nanomesh_login_draft', JSON.stringify({
          email: emailInput ? emailInput.value : '',
          password: pwdInput ? pwdInput.value : '',
          termsChecked: termsCheckbox ? termsCheckbox.checked : true
        }));
      } catch (e) {}
    };

    emailInput?.addEventListener('input', saveLoginDraft);
    pwdInput?.addEventListener('input', saveLoginDraft);
    termsCheckbox?.addEventListener('change', saveLoginDraft);
    window.addEventListener('beforeunload', saveLoginDraft);
  }

  if (registerForm) {
    const usernameInput = document.getElementById('username');
    const emailPrefixInput = document.getElementById('email-prefix');
    const emailDomainInput = document.getElementById('email-domain');
    const emailDomainDisplay = document.getElementById('email-domain-value');
    const pwdInput = document.getElementById('password');
    const confirmPwdInput = document.getElementById('confirm-password');
    const refCodeInput = document.getElementById('referral-code');
    const termsCheckbox = document.getElementById('terms-checkbox');
    const codeBoxes = document.querySelectorAll('.code-box');

    // Restore draft
    try {
      const saved = sessionStorage.getItem('nanomesh_reg_draft');
      if (saved) {
        const data = JSON.parse(saved);
        if (data.username && usernameInput) usernameInput.value = data.username;
        if (data.emailPrefix && emailPrefixInput) emailPrefixInput.value = data.emailPrefix;
        if (data.emailDomain) {
          if (emailDomainInput) emailDomainInput.value = data.emailDomain;
          if (emailDomainDisplay) emailDomainDisplay.textContent = data.emailDomain;
        }
        if (data.password && pwdInput) pwdInput.value = data.password;
        if (data.confirmPassword && confirmPwdInput) confirmPwdInput.value = data.confirmPassword;
        if (data.referralCode && refCodeInput) refCodeInput.value = data.referralCode;
        if (typeof data.termsChecked === 'boolean' && termsCheckbox) {
          termsCheckbox.checked = data.termsChecked;
        }
        if (Array.isArray(data.code) && codeBoxes.length) {
          codeBoxes.forEach((box, i) => {
            if (data.code[i] !== undefined) box.value = data.code[i];
          });
        }
        // Trigger strength and mismatch validation
        if (pwdInput) pwdInput.dispatchEvent(new Event('input'));
        if (confirmPwdInput) confirmPwdInput.dispatchEvent(new Event('input'));
        updateButtonVisuals();
      }
    } catch (e) {}

    // Auto-save on input
    const saveRegDraft = () => {
      try {
        const codeArr = Array.from(codeBoxes).map(b => b.value);
        sessionStorage.setItem('nanomesh_reg_draft', JSON.stringify({
          username: usernameInput ? usernameInput.value : '',
          emailPrefix: emailPrefixInput ? emailPrefixInput.value : '',
          emailDomain: emailDomainInput ? emailDomainInput.value : '@gmail.com',
          password: pwdInput ? pwdInput.value : '',
          confirmPassword: confirmPwdInput ? confirmPwdInput.value : '',
          referralCode: refCodeInput ? refCodeInput.value : '',
          termsChecked: termsCheckbox ? termsCheckbox.checked : true,
          code: codeArr
        }));
      } catch (e) {}
    };

    usernameInput?.addEventListener('input', saveRegDraft);
    emailPrefixInput?.addEventListener('input', saveRegDraft);
    emailDomainInput?.addEventListener('change', saveRegDraft);
    pwdInput?.addEventListener('input', saveRegDraft);
    confirmPwdInput?.addEventListener('input', saveRegDraft);
    refCodeInput?.addEventListener('input', saveRegDraft);
    termsCheckbox?.addEventListener('change', saveRegDraft);
    codeBoxes.forEach(b => b.addEventListener('input', saveRegDraft));

    document.querySelectorAll('#email-domain-options .select-option').forEach(opt => {
      opt.addEventListener('click', () => setTimeout(saveRegDraft, 50));
    });

    window.addEventListener('beforeunload', saveRegDraft);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initFormPersistence();
  initThemeToggle();
  initLangToggle();
  initTurnstile();
  const emailPrefix = document.getElementById('email-prefix');
  if (emailPrefix) {
    emailPrefix.addEventListener('input', updateButtonVisuals);
  }
  const termsCheckbox = document.getElementById('terms-checkbox');
  if (termsCheckbox) {
    termsCheckbox.addEventListener('change', updateButtonVisuals);
  }

  const urlParams = new URLSearchParams(window.location.search);
  
  const refCodeInput = document.getElementById('referral-code');
  const refParam = urlParams.get('ref');
  if (refCodeInput && refParam) {
    refCodeInput.value = refParam.toUpperCase();
  }

  const errorParam = urlParams.get('error');
  if (errorParam === 'account_cooldown') {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.style.display = 'flex';
    overlay.style.position = 'fixed';
    overlay.style.top = '0'; overlay.style.left = '0';
    overlay.style.width = '100%'; overlay.style.height = '100%';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.8)';
    overlay.style.backdropFilter = 'blur(4px)';
    overlay.style.zIndex = '9999';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';
    
    overlay.innerHTML = `
      <div class="modal" style="display:block; max-width: 400px; padding: 2rem; border: 1px solid var(--border-color); background: var(--surface-color); border-radius: 16px; text-align: center;">
        <h3 style="margin-bottom:1rem; color:var(--error-color); font-size:1.25rem;">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 8px;">
            <circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          ${getLocale() === 'zh' ? '登录受阻' : 'Login Blocked'}
        </h3>
        <p style="color:var(--text-secondary); font-size:0.95rem; line-height:1.5;">${t('error.accountCooldown')}</p>
        <div style="display:flex; justify-content:center; margin-top: 2rem;">
          <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove()">${t('common.gotIt') || 'Got it'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  } else if (errorParam) {
    showToast(t(`error.${errorParam}`) || errorParam);
  }

  const togglePasswords = document.querySelectorAll('.toggle-password');
  togglePasswords.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const pwInput = document.getElementById(targetId);
      if (pwInput) {
        if (pwInput.type === 'password') {
          pwInput.type = 'text';
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
        } else {
          pwInput.type = 'password';
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
        }
      }
    });
  });

  // Login Form
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
      if (!checkTermsAgreed()) {
        e.preventDefault();
        return;
      }
      handleAuthSubmitClick(e, async () => {
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const turnstileRes = document.querySelector('[name="cf-turnstile-response"]')?.value;

        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, turnstile_token: turnstileRes }) // Fix: send as turnstile_token
          });
          if (res.ok) {
            sessionStorage.removeItem('nanomesh_login_draft');
            window.location.href = '/';
          } else {
            const resData = await res.json().catch(()=>({}));
            handleAuthError(resData, 'error.loginFailed');
          }
        } catch (err) {
          resetTurnstile();
          showToast(t('error.networkError'));
        }
      });
    });
  }

  // Register Form
  const registerForm = document.getElementById('register-form');
  if (registerForm) {
    const btnSendCode = document.getElementById('btn-send-code');
    const emailInputPrefix = document.getElementById('email-prefix');
    const emailDomainSelect = document.getElementById('email-domain');
    
    // Custom Select Logic for email domain
    const emailDomainTrigger = document.getElementById('email-domain-trigger');
    const emailDomainOptions = document.getElementById('email-domain-options');
    const emailDomainValueDisplay = document.getElementById('email-domain-value');
    
    if (emailDomainTrigger && emailDomainOptions) {
      emailDomainTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = emailDomainOptions.style.display === 'block';
        document.querySelectorAll('.select-options').forEach(opt => opt.style.display = 'none');
        emailDomainOptions.style.display = isVisible ? 'none' : 'block';
      });

      emailDomainOptions.querySelectorAll('.select-option').forEach(option => {
        option.addEventListener('click', () => {
          const val = option.getAttribute('data-value');
          emailDomainValueDisplay.textContent = val;
          if (emailDomainSelect) emailDomainSelect.value = val;
          emailDomainOptions.style.display = 'none';
        });
      });

      document.addEventListener('click', (e) => {
        if (!emailDomainTrigger.contains(e.target)) {
          emailDomainOptions.style.display = 'none';
        }
      });
    }

    // Code boxes auto-focus
    const codeBoxes = document.querySelectorAll('.code-box');
    codeBoxes.forEach((box, i) => {
      box.addEventListener('input', (e) => {
        if (e.target.value && i < codeBoxes.length - 1) {
          codeBoxes[i+1].focus();
        }
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !e.target.value && i > 0) {
          codeBoxes[i-1].focus();
        }
      });
    });

    btnSendCode.addEventListener('click', (e) => {
      handleAuthSubmitClick(e, async () => {
      const email = emailInputPrefix.value + emailDomainSelect.value;
      const turnstileRes = document.querySelector('[name="cf-turnstile-response"]')?.value;
      
      if (!emailInputPrefix.value) {
        showToast(t('auth.invalidEmail'));
        return;
      }
      if (!turnstileRes) {
        showToast('Please complete the captcha');
        return;
      }

      btnSendCode.dataset.countdown = "true";
      btnSendCode.disabled = true;
      try {
        const res = await fetch('/api/auth/send-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            email, 
            turnstile_token: turnstileRes,
            lang: getLocale()
          })
        });
        if (res.ok) {
          resetTurnstile();
          showToast(t('auth.codeSent'), 'success');
          let s = 59;
          btnSendCode.textContent = t('auth.resendTimer').replace('{s}', s);
          const intv = setInterval(() => {
            s--;
            btnSendCode.textContent = t('auth.resendTimer').replace('{s}', s);
            if (s <= 0) {
              clearInterval(intv);
              btnSendCode.dataset.countdown = "false";
              const tsRes = document.querySelector('[name="cf-turnstile-response"]')?.value;
              updateButtonVisuals();
              btnSendCode.textContent = t('auth.sendCode');
            }
          }, 1000);
        } else {
          const resData = await res.json().catch(()=>({}));
          btnSendCode.dataset.countdown = "false";
          handleAuthError(resData, 'error.networkError');
        }
      } catch (err) {
        btnSendCode.dataset.countdown = "false";
        resetTurnstile();
        showToast(t('error.networkError'));
        }
      });
    });

    const pwd = document.getElementById('password');
    const confirmPwd = document.getElementById('confirm-password');
    const confirmPwdGroup = document.getElementById('confirm-pwd-group');
    const pwdSegments = document.querySelectorAll('.pwd-segment');
    const pwdHint = document.getElementById('pwd-hint');
    const errorMsg = document.getElementById('pwd-error-msg');

    function updatePwdStrength() {
      if (!pwd) return;
      const val = pwd.value;
      let score = 0;
      if (val.length >= 8) score++;
      if (/[A-Za-z]/.test(val) && /[0-9]/.test(val)) score++;
      if (/[^A-Za-z0-9]/.test(val)) score++;

      pwdSegments.forEach((seg, i) => {
        if (score === 0) seg.style.backgroundColor = 'var(--border-color)';
        else if (score === 1 && i === 0) seg.style.backgroundColor = 'var(--error-color)';
        else if (score === 2 && i < 2) seg.style.backgroundColor = '#eab308'; // yellow
        else if (score >= 3 && i < 3) seg.style.backgroundColor = 'var(--success-color)';
        else seg.style.backgroundColor = 'var(--border-color)';
      });

      if (val.length > 0 && score < 3) {
        if(pwdHint) pwdHint.textContent = t('auth.passwordRule') || 'Needs letters, numbers, symbols';
      } else {
        if(pwdHint) pwdHint.textContent = '';
      }
    }

    function checkConfirmPwd() {
      if (!confirmPwd) return;
      if (confirmPwd.value && confirmPwd.value !== pwd.value) {
        if(confirmPwdGroup) confirmPwdGroup.style.borderColor = 'var(--error-color)';
        if(errorMsg) errorMsg.style.display = 'flex';
      } else {
        if(confirmPwdGroup) confirmPwdGroup.style.borderColor = '';
        if(errorMsg) errorMsg.style.display = 'none';
      }
    }

    if (pwd) pwd.addEventListener('input', () => { updatePwdStrength(); checkConfirmPwd(); });
    if (confirmPwd) {
      confirmPwd.addEventListener('blur', checkConfirmPwd);
      confirmPwd.addEventListener('input', checkConfirmPwd);
    }

    registerForm.addEventListener('submit', (e) => {
      if (!checkTermsAgreed()) {
        e.preventDefault();
        return;
      }
      handleAuthSubmitClick(e, async () => {
      const username = document.getElementById('username').value;
      const email = emailInputPrefix.value + emailDomainSelect.value;
      const password = pwd.value;
      const confirmPassword = confirmPwd.value;
      
      let code = '';
      codeBoxes.forEach(b => code += b.value);

      if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return showToast(t('auth.usernameRule'));
      if (password !== confirmPassword) {
        checkConfirmPwd();
        return;
      }
      if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
        return showToast(t('auth.passwordRule'));
      }

      const turnstileRes = document.querySelector('[name="cf-turnstile-response"]')?.value;
      const refCodeInput = document.getElementById('referral-code');
      const referral_code = refCodeInput ? refCodeInput.value.trim() : '';

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, email, password, code, turnstile_token: turnstileRes, referral_code })
        });
        if (res.ok) {
          sessionStorage.removeItem('nanomesh_reg_draft');
          window.location.href = '/';
        } else {
          const resData = await res.json().catch(()=>({}));
          if (resData.error && (resData.error.includes('exists') || resData.error.includes('register') || resData.error.includes('UNIQUE constraint'))) {
            resetTurnstile();
            // Show custom modal
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay active';
            overlay.innerHTML = `
              <div class="modal" style="background:var(--surface-color); border:1px solid var(--border-color); padding:1.5rem; border-radius:12px; max-width:400px; text-align:center;">
                <h3 style="margin-bottom:1rem; color:var(--text-primary); font-size:1.1rem;">Info</h3>
                <div style="margin-bottom:1.5rem; color:var(--text-secondary); font-size:0.9rem;">${t('auth.emailExists')}</div>
                <div style="display:flex; gap:1rem; justify-content:center;">
                  <button class="btn btn-primary" onclick="window.location.href='/login.html'">${t('auth.goToLogin')}</button>
                  <button class="btn btn-outline" onclick="this.closest('.modal-overlay').remove()">Close</button>
                </div>
              </div>
            `;
            document.body.appendChild(overlay);
          } else {
            handleAuthError(resData, 'error.registerFailed');
          }
        }
      } catch (err) {
        resetTurnstile();
        showToast(t('error.networkError'));
        }
      });
    });
  }

  // Passkey Login
  function bufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBuffer(base64url) {
    const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
    const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  async function handlePasskeyLogin() {
    if (!checkTermsAgreed()) return;

    if (!window.PublicKeyCredential) {
      showToast(t('auth.passkeyUnsupported'));
      return;
    }

    const passkeyBtn = document.getElementById('btn-passkey');
    const originalText = passkeyBtn?.innerHTML;
    if (passkeyBtn) {
      passkeyBtn.disabled = true;
      passkeyBtn.style.opacity = '0.7';
    }

    try {
      const emailInput = document.getElementById('email');
      const email = emailInput ? emailInput.value.trim() : '';

      const optRes = await fetch('/api/auth/passkey/login/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(email ? { email } : {})
      });

      if (!optRes.ok) {
        const errData = await optRes.json().catch(() => ({}));
        showToast(t(errData.error || 'error.loginFailed'));
        return;
      }

      const options = await optRes.json();
      options.challenge = base64UrlToBuffer(options.challenge);
      if (options.allowCredentials && options.allowCredentials.length > 0) {
        options.allowCredentials = options.allowCredentials.map(c => ({
          ...c,
          id: base64UrlToBuffer(c.id)
        }));
      } else {
        delete options.allowCredentials;
      }

      showToast(t('auth.passkeyVerifying'), 'info');

      const credential = await navigator.credentials.get({ publicKey: options });
      if (!credential) {
        showToast(t('auth.passkeyCancelled'));
        return;
      }

      const verifyPayload = {
        id: credential.id,
        rawId: bufferToBase64Url(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
          authenticatorData: bufferToBase64Url(credential.response.authenticatorData),
          signature: bufferToBase64Url(credential.response.signature),
          userHandle: credential.response.userHandle ? bufferToBase64Url(credential.response.userHandle) : null
        }
      };

      const verifyRes = await fetch('/api/auth/passkey/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(verifyPayload)
      });

      if (verifyRes.ok) {
        sessionStorage.removeItem('nanomesh_login_draft');
        window.location.href = '/';
      } else {
        const errData = await verifyRes.json().catch(() => ({}));
        showToast(t(errData.error || 'auth.passkeyFailed'));
      }
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
        showToast(t('auth.passkeyCancelled'));
      } else {
        console.error('[Passkey] Login error:', err);
        showToast(t('auth.passkeyFailed'));
      }
    } finally {
      if (passkeyBtn) {
        passkeyBtn.disabled = false;
        passkeyBtn.style.opacity = '1';
        if (originalText) passkeyBtn.innerHTML = originalText;
      }
    }
  }

  document.getElementById('btn-passkey')?.addEventListener('click', handlePasskeyLogin);

  // OAuth
  document.getElementById('btn-github')?.addEventListener('click', (e) => {
    if (!checkTermsAgreed()) {
      e.preventDefault();
      return;
    }
    window.location.href = '/api/auth/github';
  });
  document.getElementById('btn-google')?.addEventListener('click', (e) => {
    if (!checkTermsAgreed()) {
      e.preventDefault();
      return;
    }
    window.location.href = '/api/auth/google';
  });
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    updateButtonVisuals();
  }
});
