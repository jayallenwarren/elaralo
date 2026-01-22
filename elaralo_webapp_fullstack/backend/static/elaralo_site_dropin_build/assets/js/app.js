// Common wiring for Stripe Payment Links and Add Minutes
(async function(){
  try {
    const res = await fetch('/assets/config.json');
    const cfg = await res.json();
    // Plan buttons
    document.querySelectorAll('[data-plan]').forEach(btn => {
      const key = btn.getAttribute('data-plan');
      if (cfg.stripe && cfg.stripe.plans && cfg.stripe.plans[key]) {
        btn.setAttribute('href', cfg.stripe.plans[key]);
      } else {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          alert('Payment link not configured. Update assets/config.json.');
        });
      }
    });
    // SKU buttons
    document.querySelectorAll('[data-sku]').forEach(btn => {
      const sku = btn.getAttribute('data-sku');
      if (cfg.stripe && cfg.stripe.skus && cfg.stripe.skus[sku]) {
        btn.setAttribute('href', cfg.stripe.skus[sku]);
      } else {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          alert('Payment link not configured. Update assets/config.json.');
        });
      }
    });
  } catch(err){
    // Config missing
    console.warn('config.json not found or invalid', err);
  }
})();