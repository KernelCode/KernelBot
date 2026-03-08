(function () {
  const form = document.getElementById('login-form');
  const errorMsg = document.getElementById('error-msg');
  const btn = document.getElementById('login-btn');
  const btnText = btn.querySelector('.btn-text');
  const btnLoading = btn.querySelector('.btn-loading');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorMsg.textContent = '';

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) {
      errorMsg.textContent = 'Username and password required';
      return;
    }

    btn.disabled = true;
    btnText.style.display = 'none';
    btnLoading.style.display = 'inline';

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (data.success) {
        window.location.href = '/';
      } else {
        errorMsg.textContent = data.error || 'Authentication failed';
      }
    } catch {
      errorMsg.textContent = 'Connection error';
    } finally {
      btn.disabled = false;
      btnText.style.display = 'inline';
      btnLoading.style.display = 'none';
    }
  });
})();
