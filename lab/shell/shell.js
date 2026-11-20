const buttons = [...document.querySelectorAll('button[data-mode]')]
const status = document.querySelector('#status')
for (const button of buttons) {
  button.addEventListener('click', () => window.lab.select(button.dataset.mode))
}
window.lab.onState(state => {
  status.textContent = state.message
  status.dataset.error = state.error
  for (const button of buttons) {
    button.disabled = !state.ready
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.active))
  }
})
