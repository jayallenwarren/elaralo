// Validate 18+ from DOB and save profile to localStorage
document.getElementById('signupForm').addEventListener('submit', function(e){
  e.preventDefault();
  const data = Object.fromEntries(new FormData(this).entries());
  const dob = new Date(data.dob);
  const now = new Date();
  const age = (now - dob) / (365.25*24*3600*1000);
  if (!isFinite(age) || age < 18){
    alert('Adults 18+ only.');
    return;
  }
  // Persist to localStorage (demo)
  localStorage.setItem('elaraloProfile', JSON.stringify({
    name: (data.firstName || '') + ' ' + (data.lastName || ''),
    dob: data.dob,
    address: [data.addr1, data.addr2, data.city, data.state, data.zip].filter(Boolean).join(', '),
    tier: 'Trial',
    textMin: 0,
    ttsMin: 0
  }));
  window.location.href = '/member/account.html';
});