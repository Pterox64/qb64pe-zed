'$INCLUDE:'missing.bi'

SUB Dup
END SUB

SUB Dup
END SUB

SUB Unused
    DIM unusedVar AS INTEGER
    unusedVar = 1
END SUB

SUB Jumper
    GOTO nowhere
END SUB
