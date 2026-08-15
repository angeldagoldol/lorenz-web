/* =========================================================
   INTRO ANIMATION (auto-plays on page open, no login)
   ========================================================= */
(function runIntro() {
  const overlay = document.getElementById("introOverlay");
  const walker = document.getElementById("introWalker");
  const skipBtn = document.getElementById("introSkip");
  const textInner = document.getElementById("introTextInner");

  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  if (!overlay) return;

  // Respect reduced-motion: skip the whole sequence instantly
  if (reducedMotion) {
    overlay.remove();
    return;
  }

  document.body.style.overflow = "hidden";

  const lines = [
    "> booting Angel's portfolio...",
    "> welcome — take a look around",
  ];

  function typeLines(index, callback) {
    if (index >= lines.length) {
      callback();
      return;
    }
    const line = lines[index];
    let i = 0;
    textInner.textContent = "";
    const typer = setInterval(() => {
      textInner.textContent = line.slice(0, i + 1);
      i++;
      if (i >= line.length) {
        clearInterval(typer);
        setTimeout(() => typeLines(index + 1, callback), 550);
      }
    }, 32);
  }

  function finishIntro() {
    overlay.classList.add("intro-overlay--hidden");
    document.body.style.overflow = "";
    setTimeout(() => overlay.remove(), 650);
  }

  let finished = false;
  function endOnce() {
    if (finished) return;
    finished = true;
    finishIntro();
  }

  // When the walker finishes crossing the scene, mark arrival (stops legs,
  // reveals the briefcase) then start the typed lines
  walker.addEventListener("animationend", function onArrive() {
    walker.removeEventListener("animationend", onArrive);
    walker.setAttribute("data-arrived", "true");
    typeLines(0, () => setTimeout(endOnce, 500));
  });

  skipBtn.addEventListener("click", endOnce);

  // Safety net: never let the intro block the site for more than 6s
  setTimeout(endOnce, 6000);
})();

/* =========================================================
   DOT NAVIGATION
   ========================================================= */
(function initDotNav() {
  const dots = Array.from(document.querySelectorAll(".dot-nav__dot"));
  const prevBtn = document.getElementById("dotPrev");
  const nextBtn = document.getElementById("dotNext");
  if (!dots.length) return;

  const sections = dots
    .map((dot) => document.querySelector(dot.getAttribute("data-target")))
    .filter(Boolean);

  let activeIndex = 0;

  function setActive(index) {
    activeIndex = Math.max(0, Math.min(index, dots.length - 1));
    dots.forEach((dot, i) => dot.classList.toggle("active", i === activeIndex));
  }

  dots.forEach((dot, i) => {
    dot.addEventListener("click", () => {
      sections[i].scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  prevBtn.addEventListener("click", () => {
    const target = Math.max(0, activeIndex - 1);
    sections[target].scrollIntoView({ behavior: "smooth", block: "start" });
  });

  nextBtn.addEventListener("click", () => {
    const target = Math.min(dots.length - 1, activeIndex + 1);
    sections[target].scrollIntoView({ behavior: "smooth", block: "start" });
  });

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const idx = sections.indexOf(entry.target);
            if (idx !== -1) setActive(idx);
          }
        });
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 }
    );
    sections.forEach((section) => observer.observe(section));
  }

  setActive(0);
})();

/* =========================================================
   MOBILE MENU
   ========================================================= */
const burgerBtn = document.getElementById("burgerBtn");
const mobileMenu = document.getElementById("mobileMenu");

burgerBtn.addEventListener("click", () => {
  const isOpen = mobileMenu.classList.toggle("open");
  burgerBtn.classList.toggle("open", isOpen);
  burgerBtn.setAttribute("aria-expanded", String(isOpen));
});

mobileMenu.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    mobileMenu.classList.remove("open");
    burgerBtn.classList.remove("open");
    burgerBtn.setAttribute("aria-expanded", "false");
  });
});

/* =========================================================
   SCROLL REVEAL
   ========================================================= */
const revealTargets = document.querySelectorAll(
  ".section, .skill-card, .project-card, .timeline__item, .contact-card"
);

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

if (!prefersReducedMotion && "IntersectionObserver" in window) {
  revealTargets.forEach((el) => {
    el.style.opacity = "0";
    el.style.transform = "translateY(18px)";
    el.style.transition = "opacity 0.6s ease, transform 0.6s ease";
  });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.style.opacity = "1";
          entry.target.style.transform = "translateY(0)";
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );

  revealTargets.forEach((el) => observer.observe(el));
}

/* =========================================================
   PHOTO UPLOAD
   ========================================================= */
const avatarInput = document.getElementById("avatarInput");
const avatarImg = document.getElementById("avatarImg");
const avatarPlaceholder = document.getElementById("avatarPlaceholder");
const avatarRemove = document.getElementById("avatarRemove");
const avatarEditLabel = document.querySelector(".avatar__edit");

const AVATAR_STORAGE_KEY = "portfolio_avatar_dataurl";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2MB

function setAvatar(dataUrl) {
  avatarImg.src = dataUrl;
  avatarImg.hidden = false;
  avatarPlaceholder.hidden = true;
  avatarRemove.hidden = false;
}

function clearAvatar() {
  avatarImg.src = "";
  avatarImg.hidden = true;
  avatarPlaceholder.hidden = false;
  avatarRemove.hidden = true;
  try {
    localStorage.removeItem(AVATAR_STORAGE_KEY);
  } catch (e) {
    /* storage unavailable, ignore */
  }
}

// Restore a previously uploaded photo, if any (takes priority over a hardcoded one)
try {
  const saved = localStorage.getItem(AVATAR_STORAGE_KEY);
  if (saved) {
    setAvatar(saved);
  } else if (avatarImg.getAttribute("src")) {
    // A photo was hardcoded directly in the HTML (src="my-photo.jpg")
    avatarImg.addEventListener("load", () => {
      avatarImg.hidden = false;
      avatarPlaceholder.hidden = true;
      avatarRemove.hidden = false;
      // Convert to a data URL so it can also be embedded in the PDF
      try {
        const canvas = document.createElement("canvas");
        canvas.width = avatarImg.naturalWidth;
        canvas.height = avatarImg.naturalHeight;
        canvas.getContext("2d").drawImage(avatarImg, 0, 0);
        resumeData.photo = canvas.toDataURL("image/jpeg", 0.92);
      } catch (e) {
        /* cross-origin or canvas issue — photo still shows on the page,
           it just won't be embeddable in the generated PDF */
      }
    });
  }
} catch (e) {
  /* storage unavailable (e.g. private browsing) — skip restore */
}

avatarInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    alert("Please choose an image file (PNG, JPG, or WEBP).");
    avatarInput.value = "";
    return;
  }

  if (file.size > MAX_AVATAR_BYTES) {
    alert("Please choose an image under 2MB.");
    avatarInput.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    setAvatar(dataUrl);
    resumeData.photo = dataUrl;
    try {
      localStorage.setItem(AVATAR_STORAGE_KEY, dataUrl);
    } catch (e) {
      /* storage full or unavailable — photo still shows for this session */
    }
  };
  reader.readAsDataURL(file);
});

avatarRemove.addEventListener("click", () => {
  clearAvatar();
  resumeData.photo = null;
  avatarInput.value = "";
});

avatarEditLabel.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    avatarInput.click();
  }
});

/* =========================================================
   RESUME DATA (single source of truth)
   ========================================================= */
const resumeData = {
  photo: null,
  name: "Angel Mc Lorenz K. Dagoldol",
  alias: "Vibe Coder",
  status: "2nd Year IT Student",
  school: "St. John Paul II College of Davao",
  emails: [
    "angelmclorenzdagoldol@gmail.com",
    "angel_dagoldol@sjp2cd.edu.ph",
  ],
  numbers: ["0963 202 0563", "0970 968 6995"],
  skills: {
    "Web Fundamentals": ["HTML", "CSS", "JavaScript"],
    "Programming & Logic": ["Java", "C++", "C#"],
    "Business Sense": ["Client Handling", "E-commerce", "Problem Solving"],
  },
  projects: [
    {
      title: "Web E-Commerce Platform",
      desc: "Web-based e-commerce build combining a clean storefront UI with practical, business-first thinking, built using HTML, CSS, and JavaScript.",
    },
  ],
  experience: [
    {
      period: "Ongoing",
      title: "2nd Year Student",
      org: "St. John Paul II College of Davao",
      desc: "Building on fundamentals in programming, logic, and web development.",
    },
    {
      period: "2-3 years",
      title: "Business Experience",
      org: "Self-employed / Business",
      desc: "Hands-on experience running and supporting a business.",
    },
  ],
};

/* =========================================================
   PDF GENERATION
   ========================================================= */
function generateResumePDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  const marginX = 50;
  let y = 60;

  const accent = [30, 140, 120]; // teal-ish, print-safe
  const dark = [25, 28, 36];
  const gray = [110, 118, 132];

  // Photo (if uploaded) — top right corner, header text shifts left of it
  const hasPhoto = !!resumeData.photo;
  const photoSize = 66;
  const headerRightEdge = hasPhoto ? 545 - photoSize - 16 : 545;

  if (hasPhoto) {
    try {
      const format = resumeData.photo.includes("image/png") ? "PNG" : "JPEG";
      doc.addImage(
        resumeData.photo,
        format,
        545 - photoSize,
        y - 40,
        photoSize,
        photoSize
      );
    } catch (e) {
      /* if the image fails to embed, just skip it */
    }
  }

  // Name
  doc.setFont("helvetica", "bold");
  doc.setFontSize(24);
  doc.setTextColor(...dark);
  doc.text(doc.splitTextToSize(resumeData.name, headerRightEdge - marginX), marginX, y);

  // Alias / status line
  y += 22;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.setTextColor(...accent);
  doc.text(
    doc.splitTextToSize(
      `${resumeData.alias}  •  ${resumeData.status}  •  ${resumeData.school}`,
      headerRightEdge - marginX
    ),
    marginX,
    y
  );

  // Contact line
  y += 18;
  doc.setFontSize(10);
  doc.setTextColor(...gray);
  doc.text(resumeData.emails.join("   |   "), marginX, y);
  y += 14;
  doc.text(resumeData.numbers.join("   |   "), marginX, y);

  y = Math.max(y, hasPhoto ? y - 40 + photoSize + 10 : y);
  y += 10;
  doc.setDrawColor(220, 220, 220);
  doc.line(marginX, y, 545, y);
  y += 28;

  function sectionHeader(label) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(...dark);
    doc.text(label, marginX, y);
    y += 6;
    doc.setDrawColor(...accent);
    doc.setLineWidth(1.4);
    doc.line(marginX, y, marginX + 34, y);
    doc.setLineWidth(0.2);
    y += 20;
  }

  function bodyText(text, size = 10.5, color = dark, lineHeight = 14) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, 495 - marginX);
    doc.text(lines, marginX, y);
    y += lines.length * lineHeight;
  }

  // About
  sectionHeader("About");
  bodyText(
    "Self-taught vibe coder and 2nd year IT student at St. John Paul II College of Davao. " +
      "Brings 2-3 years of hands-on business experience together with a growing foundation in " +
      "web development and programming, focused on building practical, user-first products."
  );
  y += 14;

  // Skills
  sectionHeader("Skills");
  Object.entries(resumeData.skills).forEach(([group, items]) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...dark);
    doc.text(group + ":", marginX, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...gray);
    doc.text(items.join(", "), marginX + 130, y);
    y += 18;
  });
  y += 10;

  // Projects
  sectionHeader("Projects");
  resumeData.projects.forEach((p) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...dark);
    doc.text(p.title, marginX, y);
    y += 15;
    bodyText(p.desc, 10, gray, 13);
    y += 8;
  });
  y += 6;

  // Experience & Education
  sectionHeader("Experience & Education");
  resumeData.experience.forEach((e) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...dark);
    doc.text(`${e.title}  —  ${e.org}`, marginX, y);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(9.5);
    doc.setTextColor(...accent);
    doc.text(e.period, 495 - doc.getTextWidth(e.period), y);
    y += 15;
    bodyText(e.desc, 10, gray, 13);
    y += 10;
  });

  doc.save("Angel_Dagoldol_Resume.pdf");
}

/* Wire up every download button */
["navResumeBtn", "heroResumeBtn", "footerResumeBtn"].forEach((id) => {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener("click", generateResumePDF);
});
