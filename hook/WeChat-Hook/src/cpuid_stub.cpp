// cpuid.asm 的等价桩：MinGW 不带 NASM，这里返回 0 表示不支持高级指令集，
// 调用方会退回通用实现（只影响扫描速度，不影响正确性）。
#include <cstdint>

extern "C" uint32_t CalcCpuFeatureMask(uint32_t inputMask) {
    (void)inputMask;
    return 0;
}
