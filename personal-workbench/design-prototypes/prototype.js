const taskItems = [...document.querySelectorAll('[data-task]')];
const detailTitles = [...document.querySelectorAll('[data-detail-title]')];
const detailMetas = [...document.querySelectorAll('[data-detail-meta]')];
const detailProgressValues = [...document.querySelectorAll('[data-detail-progress]')];

const updateText = (elements, value) => {
  elements.forEach((element) => {
    element.textContent = value;
  });
};

taskItems.forEach((item) => {
  item.addEventListener('click', () => {
    taskItems.forEach((candidate) => candidate.classList.remove('is-selected'));
    item.classList.add('is-selected');
    updateText(detailTitles, item.dataset.title || '\u672a\u547d\u540d\u4efb\u52a1');
    updateText(detailMetas, item.dataset.meta || '');
    updateText(detailProgressValues, item.dataset.progress || '0/1');
  });
});

document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach((candidate) => candidate.classList.remove('is-active'));
    button.classList.add('is-active');
    const filter = button.dataset.filter;
    taskItems.forEach((item) => {
      item.hidden = filter !== 'all' && item.dataset.status !== filter;
    });
  });
});

const detailPanel = document.querySelector('[data-detail-panel]');
document.querySelectorAll('[data-toggle-detail]').forEach((button) => {
  button.addEventListener('click', () => detailPanel?.classList.toggle('is-collapsed'));
});

const terminal = document.querySelector('[data-terminal]');
document.querySelectorAll('[data-toggle-terminal]').forEach((button) => {
  button.addEventListener('click', () => terminal?.classList.toggle('is-open'));
});

document.querySelectorAll('[data-demo-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const original = button.innerHTML;
    button.textContent = '\u5df2\u8fdb\u5165\u5de5\u4f5c\u533a';
    button.classList.add('is-confirmed');
    window.setTimeout(() => {
      button.innerHTML = original;
      button.classList.remove('is-confirmed');
      if (window.lucide) window.lucide.createIcons();
    }, 1400);
  });
});

if (window.lucide) window.lucide.createIcons();
