// Member area demo using localStorage
function getProfile(){
  try { return JSON.parse(localStorage.getItem('elaraloProfile')||'{}'); }
  catch(e){ return {}; }
}
function saveProfile(p){ localStorage.setItem('elaraloProfile', JSON.stringify(p||{})); }

function hydrateAccount(){
  const p = getProfile();
  const $ = (id)=>document.getElementById(id);
  if ($('name')) $('name').textContent = p.name || '—';
  if ($('dob')) $('dob').textContent = p.dob || '—';
  if ($('address')) $('address').textContent = p.address || '—';
  if (document.getElementById('tier')) document.getElementById('tier').textContent = p.tier || 'Trial';
  if (document.getElementById('textBal')) document.getElementById('textBal').textContent = p.textMin || 0;
  if (document.getElementById('ttsBal')) document.getElementById('ttsBal').textContent = p.ttsMin || 0;
}

document.addEventListener('DOMContentLoaded', ()=>{
  hydrateAccount();
  // Upgrade buttons
  document.querySelectorAll('[data-plan]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const plan = btn.getAttribute('data-plan');
      const p = getProfile();
      if (!p.name){
        alert('Please create an account first.');
        window.location.href = '/signup.html';
        return;
      }
      // Update tier locally (demo). Real site should rely on backend/Stripe webhooks.
      if (plan === 'member_friend') p.tier = 'Member — Friend';
      if (plan === 'member_romantic') p.tier = 'Member — Romantic';
      if (plan === 'member_intimate') p.tier = 'Member — Intimate 18+';
      saveProfile(p);
      alert('Tier updated locally (demo). Configure Stripe links in assets/config.json for production.');
      hydrateAccount();
    });
  });

  // Buy SKU buttons
  document.querySelectorAll('[data-sku]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      const sku = btn.getAttribute('data-sku');
      const p = getProfile();
      if (!p.name){
        alert('Please create an account first.');
        window.location.href = '/signup.html';
        return;
      }
      // Demo credit: add minutes locally
      if (sku.startsWith('text_')) p.textMin = (p.textMin||0) + parseInt(sku.split('_')[1].replace('m',''),10);
      if (sku.startsWith('tts_')) p.ttsMin = (p.ttsMin||0) + parseInt(sku.split('_')[1].replace('m',''),10);
      saveProfile(p);
      hydrateAccount();
      alert('Minutes credited locally (demo). Configure Stripe links in assets/config.json for production.');
    });
  });

  // Address form save
  const addrForm = document.getElementById('addrForm');
  if (addrForm){
    addrForm.addEventListener('submit', (e)=>{
      e.preventDefault();
      const data = Object.fromEntries(new FormData(addrForm).entries());
      const p = getProfile();
      p.address = [data.addr1, data.addr2, data.city, data.state, data.zip].filter(Boolean).join(', ');
      saveProfile(p);
      alert('Saved.');
      window.location.href = '/member/account.html';
    });
  }
});