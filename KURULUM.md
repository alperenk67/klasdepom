# Depo Takip – Kurulum (Android & iPhone)

Sunucu gerekmez. Dosyalar Netlify'da durur; telefon uygulamayı kendine kaydeder ve sonra
internetsiz çalışır. Tüm stok ve satış verileri telefonun içinde kalır.

## 1. Netlify'daki siteyi güncelleyin (adres aynı kalır)
1. Netlify'da projenize girin → **Deploys** sekmesi.
2. Sayfanın altındaki "Drag and drop your project folder here" alanına yeni `depo-web` klasörünü sürükleyin.
3. Proje hâlâ "only visible to your team" ise **Make public** deyin
   (sitede sadece boş uygulama var; veriler telefonda tutulur).

> Adresi değiştirmeyin: telefondaki veriler o adrese bağlıdır.

## 2. Android telefona yükleyin
1. Adresi **Chrome** ile açın (internet varken).
2. Özet ekranında **"📲 Yükle"** düğmesi çıkar → Yükle.
   Çıkmazsa: Chrome menüsü (⋮) → **Uygulamayı yükle** / **Ana ekrana ekle**.
3. Bundan sonra uygulamayı **ana ekrandaki Depo simgesinden** açın.
4. **Stok Girişi** sekmesine girip kameraya izin verin (barkod sadece burada okutulur).

## 3. iPhone'a yükleme (sonra)
Adresi **Safari** ile açın → Paylaş (□↑) → **Ana Ekrana Ekle**. Gerisi aynı.

## Kullanım
- **Stok Girişi**: Gelen ürünü okutun. Yeni ürünse adını yazın, isterseniz gri kutuya dokunup **fotoğrafını çekin**, adedi girin → *Stoğa Ekle*.
  - **📷 Barkodsuz ürün**: Barkodu olmayan ürünü fotoğrafını çekerek ekleyin (ad + adet).
  - **📋 Listeden seç**: Fotoğraflı ürün listesinden seçip stok ekleyin (barkodsuz ürünlere yeni stok gelince).
- **Satış** (barkod okutulmaz): Ürün listesinde satılan ürünlerin adedini **+ / −** ile işaretleyin
  (sayıya dokunup adedi doğrudan da yazabilirsiniz) → alttaki **Satışı Tamamla**. Stok o an düşer.
  Stoktakinden fazlası işaretlenemez. Yanlış satışta **Geri al**'a basın ya da
  *Bugünkü satışlar* listesinden satışa dokunup iptal edin. İşaretlemeler uygulama kapansa da kaybolmaz.
- **Özet**: Ürün çeşidi, toplam stok, bugün satılan adet ve satış sayısı, az kalanlar, son hareketler.
- **Ürünler**: Fotoğraflı liste, arama, fotoğraf ekleme/değiştirme, ad düzeltme, sayım düzeltmesi, ürün geçmişi, silme.
- Telefonun **geri tuşu** açık pencereyi kapatır, sonra Özet'e döner.

## Yedek
- Değişiklik varsa ve son yedek 1 günden eskiyse Özet'te **"Yedek al"** uyarısı çıkar.
- **Yedek** sekmesi → *Yedeği Kaydet*:
  - Android: menüden **Google Drive** seçin (menü çıkmazsa dosya *İndirilenler*'e iner, oradan Drive'a yükleyin).
  - iPhone: **Dosyalara Kaydet → iCloud Drive**.
- Uygulama ayrıca her gün kendi içinde bir kopya tutar (son 10) — yanlış işlemden dönmek için.
- *Yedek Dosyasından Geri Yükle* ile yeni telefona taşıyabilirsiniz (Android → iPhone dahil).
- Stok listesi ve hareketler Excel için CSV olarak indirilebilir.

## Hızlı okutma ipuçları
- Android'de Chrome'un kendi barkod okuyucusu kullanılır, çok hızlıdır.
- Barkodu **beyaz çerçevenin içine yatay** tutun, 10–20 cm mesafe yeterli.
- Odaklamıyorsa biraz geri çekin; **2×** (yakınlaştırma) ve **🔦** (fener) düğmeleri telefon destekliyorsa görünür.

## Güncelleme
Dosyaları değiştirirseniz `sw.js` içindeki `VERSION` değerini artırın (ör. depo-v7) ve Netlify'a yeniden sürükleyin.
Uygulama kapatılıp açıldığında yeni sürüme geçer; veriler silinmez.
