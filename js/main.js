(function () {
  "use strict";

  var toggle = document.querySelector(".nav-toggle");
  var navList = document.getElementById("primary-nav");

  if (toggle && navList) {
    toggle.addEventListener("click", function () {
      var isOpen = navList.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
  }

  var yearNav = document.querySelector(".year-nav");
  var yearNavInner = document.querySelector(".year-nav-inner");
  if (yearNav && yearNavInner) {
    var checkYearNavOverflow = function () {
      yearNav.classList.remove("is-overflowing");
      var overflowing = yearNavInner.scrollWidth > yearNavInner.clientWidth + 1;
      yearNav.classList.toggle("is-overflowing", overflowing);
    };
    checkYearNavOverflow();
    var yearNavResizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(yearNavResizeTimer);
      yearNavResizeTimer = setTimeout(checkYearNavOverflow, 150);
    });
  }

  var yearMenu = document.querySelector(".year-menu");
  if (yearMenu) {
    yearMenu.querySelectorAll(".year-menu-panel a").forEach(function (link) {
      link.addEventListener("click", function () {
        yearMenu.removeAttribute("open");
      });
    });
  }

  var copyBtn = document.querySelector("[data-copy-link]");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var url = copyBtn.getAttribute("data-copy-link");
      var announce = function (msg) {
        var live = document.getElementById("copy-status");
        if (live) { live.textContent = msg; }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          announce("Link copied to clipboard");
        }, function () {
          announce("Could not copy link");
        });
      }
    });
  }
})();
