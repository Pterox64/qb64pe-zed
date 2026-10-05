'$INCLUDE:'lib.bi'

' A movable point in 2D space.
TYPE Vec2
    x AS SINGLE
    y AS SINGLE
END TYPE

CONST MAX_ITEMS = 8

' Moves a point and returns the new x position.
' @param p the point record
' @param dx horizontal delta
FUNCTION MoveX% (p AS Vec2, dx AS INTEGER)
    DIM total AS INTEGER
    total = p.x + dx
    MoveX% = total
END FUNCTION

SUB Greet (name AS STRING)
    PRINT "Hello, "; name
END SUB

retry:
PRINT "done"
