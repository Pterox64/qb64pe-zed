; Outline items for SUB / FUNCTION / TYPE / CONST declarations.
; `DECLARE SUB`/`DECLARE FUNCTION` prototypes are covered too, because the
; `SUB`/`FUNCTION` keyword is adjacent to the routine name.
(
  (keyword) @context
  . (identifier) @name
  (#match? @context "(?i)^(sub|function|type|const)$")
) @item
