; Comments
(comment) @comment

; Documentation comments (`' @param ...`, `' > ...`).
((comment) @comment.doc
  (#match? @comment.doc "^'\\s*[@>]"))

; Metacommands / preprocessor directives ($CONSOLE, $IF, '$INCLUDE:'file.bi').
(metacommand) @preproc

; Strings and numbers
(string) @string
(number) @number

; Keywords, built-in procedures and data types
(keyword) @keyword
(builtin) @function.builtin
(type_keyword) @type.builtin

; Labels
(label) @label

; Identifiers / variables
(identifier) @variable

; Operators
(operator) @operator

; Punctuation
[ "(" ")" "[" "]" ] @punctuation.bracket
(punctuation) @punctuation.delimiter
