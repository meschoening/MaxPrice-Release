/* The User guide's Copy buttons (ADR-0135 §4). Loaded with `defer`, and
   optional: it adds a Copy button to each Terminal block's head, which writes
   the command with navigator.clipboard and, where the clipboard is missing or
   refuses, selects the command instead. Without this script a command is
   still one click from selected (`user-select: all`). */
(function () {
  var LABEL = "Copy";
  var RESET_MS = 2000;

  function addButton(block) {
    var code = block.querySelector("pre code");
    var head = block.querySelector(".block-head");
    if (!code || !head) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy-button";
    button.textContent = LABEL;
    button.setAttribute("aria-live", "polite");

    var timer;
    function show(label) {
      button.textContent = label;
      clearTimeout(timer);
      timer = setTimeout(function () {
        button.textContent = LABEL;
      }, RESET_MS);
    }
    function selectCommand() {
      var range = document.createRange();
      range.selectNodeContents(code);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      show("Selected");
    }

    button.addEventListener("click", function () {
      if (!navigator.clipboard || !navigator.clipboard.writeText) return selectCommand();
      navigator.clipboard.writeText(code.textContent).then(function () {
        show("Copied");
      }, selectCommand);
    });
    head.appendChild(button);
  }

  var blocks = document.querySelectorAll(".terminal");
  for (var i = 0; i < blocks.length; i++) addButton(blocks[i]);
})();
