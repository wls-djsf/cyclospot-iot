#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);

// Sensores Ultrassônicos
const int tVagas[] = {2, 4, 6};
const int eVagas[] = {3, 5, 7};

// LEDs RGB (somente Verde e Vermelho)
const int ledsVerdes[] = {8, 10, 12};
const int ledsVermelhos[] = {9, 11, 13};

// Distância limite para considerar ocupada (em cm)
const int limite = 3;

// Número total de vagas
const int totalVagas = 3;

void setup() {
  Serial.begin(9600); // Velocidade padrão do cabo USB (9600 baud)

  lcd.init();
  lcd.backlight();

  lcd.setCursor(0, 0);
  lcd.print("TESTE LCD OK");

  lcd.setCursor(0, 1);
  lcd.print("Funcionando OK");

  delay(2000);
  lcd.clear();

  for (int i = 0; i < totalVagas; i++) {
    pinMode(tVagas[i], OUTPUT);
    pinMode(eVagas[i], INPUT);

    pinMode(ledsVerdes[i], OUTPUT);
    pinMode(ledsVermelhos[i], OUTPUT);

    digitalWrite(ledsVerdes[i], LOW);
    digitalWrite(ledsVermelhos[i], LOW);
  }
}

void loop() {
  int vagasOcupadas = 0;
  int distancias[totalVagas];

  for (int i = 0; i < totalVagas; i++) {
    distancias[i] = medirDistancia(tVagas[i], eVagas[i]);

    if (distancias[i] > 0 && distancias[i] <= limite) {
      vagasOcupadas++;

      // Vermelho = Ocupada
      digitalWrite(ledsVerdes[i], HIGH);
      digitalWrite(ledsVermelhos[i], LOW);
    } else {
      // Verde = Livre
      digitalWrite(ledsVerdes[i], LOW);
      digitalWrite(ledsVermelhos[i], HIGH);
    }
  }

  int vagasLivres = totalVagas - vagasOcupadas;

  lcd.setCursor(0, 0);
  lcd.print("Ocupadas: ");
  lcd.print(vagasOcupadas);
  lcd.print("   ");

  lcd.setCursor(0, 1);
  lcd.print("Livres: ");
  lcd.print(vagasLivres);
  lcd.print("   ");

  // Envia os dados em JSON pelo cabo USB para o backend/main.py do CycloSpot
  Serial.print("{\"ocupadas\":");
  Serial.print(vagasOcupadas);
  Serial.print(",\"livres\":");
  Serial.print(vagasLivres);
  Serial.print(",\"vaga1\":");
  Serial.print(distancias[0]);
  Serial.print(",\"vaga2\":");
  Serial.print(distancias[1]);
  Serial.print(",\"vaga3\":");
  Serial.print(distancias[2]);
  Serial.println("}");

  delay(500);
}

int medirDistancia(int pinT, int pinE) {
  digitalWrite(pinT, LOW);
  delayMicroseconds(5);

  digitalWrite(pinT, HIGH);
  delayMicroseconds(10);

  digitalWrite(pinT, LOW);

  long duracao = pulseIn(pinE, HIGH, 10000);

  if (duracao == 0) {
    return 999;
  }

  int distancia = duracao * 0.0343 / 2;
  return distancia;
}
