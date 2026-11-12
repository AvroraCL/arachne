export function createMeshSmoothingDialog({smooth, focus}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'paint-form-dialog mesh-smoothing-dialog';
  dialog.setAttribute('aria-label', '平滑顶点');
  dialog.innerHTML = `
    <form>
      <header><h2>平滑顶点</h2></header>
      <div class="paint-form-content">
        <label>平滑系数<input name="factor" type="number" value="0.5" min="0.01" max="1" step="0.01" data-scrub-number data-scrub-speed=".01" required autofocus></label>
        <label>重复次数<input name="iterations" type="number" value="1" min="1" max="20" step="1" data-scrub-number required></label>
        <fieldset><legend>局部轴</legend>
          <label><input type="checkbox" name="x" checked>X</label>
          <label><input type="checkbox" name="y" checked>Y</label>
          <label><input type="checkbox" name="z" checked>Z</label>
        </fieldset>
        <label class="mesh-smoothing-boundary"><input type="checkbox" name="keepBoundary" checked>保留开放边界</label>
      </div>
      <footer class="paint-form-footer">
        <span role="alert"></span>
        <button type="button" value="cancel">取消</button>
        <button type="submit" class="primary">应用平滑</button>
      </footer>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form'), fields = form.elements;
  const submit = form.querySelector('[type=submit]'), cancel = form.querySelector('[value=cancel]');
  const error = form.querySelector('[role=alert]');
  let pending = false;
  cancel.onclick = () => dialog.close();
  dialog.oncancel = event => { if (pending) event.preventDefault(); };
  dialog.onclose = () => focus();
  form.onsubmit = async event => {
    event.preventDefault();
    if (pending) return;
    const options = {
      factor: fields.factor.valueAsNumber, iterations: fields.iterations.valueAsNumber,
      axes: [fields.x.checked, fields.y.checked, fields.z.checked], keepBoundary: fields.keepBoundary.checked
    };
    error.textContent = '';
    pending = true;
    for (const field of fields) field.disabled = true;
    submit.textContent = '正在保存…';
    try {
      await smooth(options);
      dialog.close();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      pending = false;
      for (const field of fields) field.disabled = false;
      submit.textContent = '应用平滑';
    }
  };
  return {
    open() { error.textContent = ''; dialog.showModal(); },
    isOpen: () => dialog.open,
    dispose() { dialog.remove(); }
  };
}
