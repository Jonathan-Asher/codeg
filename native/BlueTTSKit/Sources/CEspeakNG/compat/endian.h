/* <endian.h> for espeak-ng on Apple platforms.
 *
 * Adapted from espeak-ng's src/include/compat/endian.h (public domain, see
 * below). Recent Apple SDKs ship an <endian.h> without the le16toh() family,
 * so on Apple we always map them to <libkern/OSByteOrder.h> instead of
 * deferring to the system header.
 *
 * Original: https://gist.github.com/panzi/6856583 (Mathias Panzenböck, public
 * domain; dual licensed BSD/MIT/Apache where public domain is not recognized).
 */
#ifndef ENDIAN_H_COMPAT_SHIM
#define ENDIAN_H_COMPAT_SHIM
#pragma once

#if defined(__APPLE__)
#	include <libkern/OSByteOrder.h>
#	include <machine/endian.h>
#	ifndef htobe16
#		define htobe16(x) OSSwapHostToBigInt16(x)
#	endif
#	ifndef htole16
#		define htole16(x) OSSwapHostToLittleInt16(x)
#	endif
#	ifndef be16toh
#		define be16toh(x) OSSwapBigToHostInt16(x)
#	endif
#	ifndef le16toh
#		define le16toh(x) OSSwapLittleToHostInt16(x)
#	endif
#	ifndef htobe32
#		define htobe32(x) OSSwapHostToBigInt32(x)
#	endif
#	ifndef htole32
#		define htole32(x) OSSwapHostToLittleInt32(x)
#	endif
#	ifndef be32toh
#		define be32toh(x) OSSwapBigToHostInt32(x)
#	endif
#	ifndef le32toh
#		define le32toh(x) OSSwapLittleToHostInt32(x)
#	endif
#	ifndef htobe64
#		define htobe64(x) OSSwapHostToBigInt64(x)
#	endif
#	ifndef htole64
#		define htole64(x) OSSwapHostToLittleInt64(x)
#	endif
#	ifndef be64toh
#		define be64toh(x) OSSwapBigToHostInt64(x)
#	endif
#	ifndef le64toh
#		define le64toh(x) OSSwapLittleToHostInt64(x)
#	endif
#	ifndef __BYTE_ORDER
#		define __BYTE_ORDER    BYTE_ORDER
#	endif
#	ifndef __BIG_ENDIAN
#		define __BIG_ENDIAN    BIG_ENDIAN
#	endif
#	ifndef __LITTLE_ENDIAN
#		define __LITTLE_ENDIAN LITTLE_ENDIAN
#	endif
#else
#	pragma GCC system_header
#	include_next <endian.h>
#endif

#endif
