// popup.js — popup UI controller: boots i18n and wires DOM events (logic TBD)

document.addEventListener('DOMContentLoaded', async () => {
  await initI18n();
  applyTranslations(document.body);

  const segActive = document.querySelector(`#ui-lang-seg span[data-lang="${getCurrentLanguage()}"]`);
  if (segActive) {
    document.querySelectorAll('#ui-lang-seg span').forEach(s => s.classList.remove('active'));
    segActive.classList.add('active');
  }
});
