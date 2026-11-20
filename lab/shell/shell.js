const buttons = [...document.querySelectorAll('button[data-mode]')]
const example = document.querySelector('#example')
const status = document.querySelector('#status')
for (const button of buttons) {
  button.addEventListener('click', () => window.lab.select(button.dataset.mode))
}
window.lab.onState(state => {
  example.hidden = state.example === undefined
  example.textContent = state.example === undefined ? '' : 'Пример ' + state.example
  status.textContent = state.message
  status.dataset.error = state.error
  for (const button of buttons) {
    button.disabled = !state.ready || state.busy
    if (button.hasAttribute('aria-pressed')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === state.active))
    }
  }
})
