(module
  (memory (export "memory") 2 64)
  (data (i32.const 65536) "{\"frames\":[{\"values\":[1],\"labels\":[\"example\"]}]}")

  (func (export "vofa_abi_version") (result i32)
    i32.const 1)

  (func (export "vofa_input_ptr") (result i32)
    i32.const 0)

  (func (export "vofa_reset") (result i32)
    i32.const 0)

  (func (export "vofa_push") (param i32 f64) (result i64)
    i64.const 281474976710704))
