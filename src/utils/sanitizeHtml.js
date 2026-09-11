const createDOMPurify = require("dompurify");
const { JSDOM } = require("jsdom");

const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

const sanitizeRichText = (dirtyHtml) => {
  if (!dirtyHtml || typeof dirtyHtml !== "string") return "";
  return DOMPurify.sanitize(dirtyHtml, {
    ALLOWED_TAGS: [
      "p", "br", "b", "i", "em", "strong", "a", "ul", "ol", "li",
      "code", "pre", "blockquote", "h1", "h2", "h3", "h4", "span", "hr"
    ],
    ALLOWED_ATTR: ["href", "target", "rel", "class"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"]
  });
};

module.exports = { sanitizeRichText };
