'use strict';
/**
 * 极简 Markdown 渲染（够 Obsidian 那种用法）：
 * 标题 / 粗斜体 / 删除线 / 行内代码 / 代码块 / 引用 / 列表 / 任务列表 /
 * 表格 / 链接 / 图片 / 分隔线 / [[双链]] / #标签
 *
 * 先整体 HTML 转义再替换标记，保证不会因为笔记内容注入标签。
 */
(function (global) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s) {
    let t = s;

    // 行内代码
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 图片
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, src) => `<img alt="${alt}" src="${src}">`);

    // 普通链接
    t = t.replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      (_, txt, href) => `<a href="${href}" target="_blank" rel="noreferrer">${txt}</a>`
    );

    // [[双链]] / [[目标|别名]]
    t = t.replace(
      /\[\[([^\]|#]+)(?:[|#]([^\]]*))?\]\]/g,
      (_, target, alias) =>
        `<a class="wikilink" data-target="${target.trim()}">${(alias || target).trim()}</a>`
    );

    // 裸 URL
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);

    // 粗体 / 斜体 / 删除线
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // #标签（前面必须是行首或空白，避免吃掉 a#b）
    t = t.replace(/(^|\s)#([\w\u4e00-\u9fa5-]+)/g, '$1<span class="tag">#$2</span>');

    return t;
  }

  const splitRow = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  function render(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 代码块
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }

      if (!line.trim()) {
        i++;
        continue;
      }

      // frontmatter（只在文件开头出现一次）
      if (i === 0 && line.trim() === '---') {
        let j = 1;
        while (j < lines.length && lines[j].trim() !== '---') j++;
        if (j < lines.length) {
          i = j + 1;
          continue;
        }
      }

      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = h[1].length;
        out.push(`<h${lvl}>${inline(esc(h[2]))}</h${lvl}>`);
        i++;
        continue;
      }

      // 引用（可嵌套内容）
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }

      // 表格
      if (line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
        out.push(
          `<table><thead><tr>${head.map((c) => `<th>${inline(esc(c))}</th>`).join('')}</tr></thead>` +
            `<tbody>${rows
              .map((r) => `<tr>${r.map((c) => `<td>${inline(esc(c))}</td>`).join('')}</tr>`)
              .join('')}</tbody></table>`
        );
        continue;
      }

      // 列表（缩进用 padding 表示层级）
      const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
      if (li) {
        const ordered = /^\d+\./.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
          if (!m) break;
          items.push({ indent: Math.floor(m[1].length / 2), text: m[3] });
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        const body = items
          .map((it) => {
            const task = it.text.match(/^\[([ xX])\]\s+(.*)$/);
            const pad = it.indent ? ` style="margin-left:${it.indent * 14}px"` : '';
            if (task) {
              const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
              return `<li class="task"${pad}><input type="checkbox" disabled${checked}> ${inline(esc(task[2]))}</li>`;
            }
            return `<li${pad}>${inline(esc(it.text))}</li>`;
          })
          .join('');
        out.push(`<${tag}>${body}</${tag}>`);
        continue;
      }

      // 段落：直到空行或下一个块级标记
      const buf = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,6}\s|```|>|\s*([-*+]|\d+\.)\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i])
      ) {
        buf.push(lines[i++]);
      }
      if (buf.length) out.push(`<p>${inline(esc(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`);
      else i++;
    }

    return out.join('\n');
  }

  global.MD = { render, inline, esc };
})(window);
