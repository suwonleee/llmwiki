---
title: Silent refusal policy
description: silentrefusalmarker keeps unrelated prompts free of wiki pointers
date: 2026-08-09
tags: [retrieval, refusal]
status: ready
domain: decision
---

silentrefusalmarker 는 관련 없는 질문에 위키 포인터를 내보내지 않는 결정적 검색 정책이다.
검색 후보가 충분한 정체성 근거를 갖지 못하면 turn-context 출력은 빈 문자열로 남는다.
이 침묵 규칙은 일반 지식 질문이 프로젝트 문서로 잘못 연결되는 일을 막는다.
공개 기준선은 같은 입력에서 같은 거절 결과를 요구하지만 실행 시간은 요구하지 않는다.
질문 언어별 거절률은 검색 도달률과 분리해 보고하여 실패 원인을 숨기지 않는다.
고정된 용어는 다른 문서와 순위 동률을 만들지 않고 정책 페이지를 직접 식별한다.
