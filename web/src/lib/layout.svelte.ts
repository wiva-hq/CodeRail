// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// The phone layout: a window 700 wide or less (public/first.js sets it for the first frame). It is `data-phone` on
// <html> (base.css's touch sizes) and `layout.phone` for the views that switch to PhoneApp.
class Layout {
  phone = $state(false);
  constructor() {
    const mq = matchMedia('(max-width: 700px)');
    const set = () => {
      this.phone = mq.matches;
      if (mq.matches) document.documentElement.dataset.phone = '1'; else delete document.documentElement.dataset.phone;
    };
    set();
    mq.addEventListener('change', set);
  }
}
export const layout = new Layout();
